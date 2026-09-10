import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  AudienceDecidePayload,
  BuildAnswerPayload,
  BuildFreezePayload,
  CostApprovePayload,
  DeliveryDecisionPayload,
  RoutePayload,
  SoloDecidePayload,
  StageApprovePayload,
} from "./domain.js";
import { COMMANDS, type Command } from "@solutions-builder/app/ledger";
import { submitAndApprove } from "./engine.js";
import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { projectDetail, readArtifactNode } from "./projects.js";
import { BRIDGE_CAPABILITIES, runBuildAttempt } from "./corbits-exec.js";
import { drainOutbox } from "./outbox.js";
import { commandFrom, parsed } from "./api.js";
import { localActor } from "./hub-client.js";

export function registerDecisionRoutes(api: Hono) {
  /** One route per command family; the ledger decides whether each is allowed. */
  api.post("/projects/:projectId/commands/:command", async (context) => {
    const projectId = context.req.param("projectId");
    const command = context.req.param("command") as Command;
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new HostError("validation_failed", `Unknown command: ${command}.`);
    }
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Validation is per command, at this boundary, once.
    switch (command) {
      case "stage.approve":
        parsed(StageApprovePayload(body));
        break;
      case "audience.decide":
        parsed(AudienceDecidePayload(body));
        break;
      case "cost.approve":
        parsed(CostApprovePayload(body));
        break;
      case "build.freeze":
        parsed(BuildFreezePayload(body));
        break;
      case "build.answer":
        parsed(BuildAnswerPayload(body));
        break;
      case "stage.reject":
      case "stage.revise":
      case "stage.route_back":
      case "build.route_material_change":
        parsed(RoutePayload(body));
        break;
      case "delivery.accept":
      case "delivery.reject":
      case "delivery.revise":
        parsed(DeliveryDecisionPayload(body));
        break;
      default:
        break;
    }

    const outcome = await commandFrom(command, projectId, body);
    await drainOutbox();
    return context.json(outcome);
  });

  /**
   * Submitting a stage for review. Separate from `/commands` because it names
   * the version being submitted and that is the whole content of the request.
   */
  api.post("/projects/:projectId/submit", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as { runId: string; versions: unknown[] };
    const outcome = await commandFrom("stage.submit", projectId, body as never);
    await drainOutbox();
    return context.json(outcome);
  });

  /**
   * The solo-approver's one action: `stage.submit` then whichever command
   * actually leaves `waiting_approval` at this stage, both through the same
   * guard `/commands` uses. Meant for the UI's collapsed button when
   * `projectDetail`'s `soloApproval` is true — nothing here checks that flag
   * itself, since the guard already refuses the approval half to anyone who
   * does not hold the authority, solo or not.
   */
  api.post("/projects/:projectId/decide", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;
    const payload = parsed(SoloDecidePayload(body));
    const outcome = await submitAndApprove({
      actor: localActor(),
      projectId,
      runId: payload.runId,
      versions: payload.versions,
      ...(payload.rationale !== undefined ? { rationale: payload.rationale } : {}),
      ...(payload.forecastUsd !== undefined ? { forecastUsd: payload.forecastUsd } : {}),
      ...(payload.assumptions !== undefined ? { assumptions: payload.assumptions } : {}),
      idempotencyKey: (body.idempotencyKey as string) ?? newId.command(),
      correlationId: newId.correlation(),
      ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
    });
    await drainOutbox();
    return context.json(outcome);
  });

  /** Starts a build attempt through the bounded bridge. */
  api.post("/projects/:projectId/build/start", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as { runId: string };
    const started = await commandFrom("build.start_attempt", projectId, body as never);

    const detail = await projectDetail(projectId, localActor().principalId);
    const packetRun = detail.runs.find((run) => run.id === started.runId);
    const [packet] = packetRun?.packetId
      ? await database()
          .db.select()
          .from(table.buildPacket)
          .where(eq(table.buildPacket.id, packetRun.packetId))
      : [];

    const plan = detail.nodes.find((node) => node.kind === "build_plan");
    const planText = plan ? (await readArtifactNode(plan.id)).content : "";

    const outcome = await runBuildAttempt({
      runId: started.runId,
      prompt: [
        `Build the software described by this approved plan. Work in the current directory.`,
        ``,
        planText,
        ``,
        `Frozen packet: ${packet?.packetHash ?? "unknown"}.`,
        `Targets: ${JSON.stringify(packet?.targets ?? [])}.`,
      ].join("\n"),
    });

    // The bridge's result is recorded as an event, not as approval or evidence.
    await database()
      .db.insert(table.buildEvent)
      .values({
        id: newId.event(),
        runId: started.runId,
        idempotencyKey: `${started.runId}:bridge-final`,
        cursor: 1,
        type: "bridge.final",
        severity: outcome.exitStatus === 0 ? "info" : "error",
        payload: {
          bridgeId: outcome.bridgeId,
          available: outcome.available,
          exitStatus: outcome.exitStatus,
          workspace: outcome.workspace,
          finalText: outcome.finalText.slice(0, 20_000),
          stderrTail: outcome.stderrTail,
          capabilities: BRIDGE_CAPABILITIES,
        },
        occurredAt: new Date(outcome.endedAt),
      })
      .onConflictDoNothing();

    return context.json({ run: started, bridge: outcome });
  });

  api.get("/projects/:projectId/build/events", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, localActor().principalId);
    const buildRuns = detail.runs.filter((run) => run.kind === "build").map((run) => run.id);
    if (buildRuns.length === 0) return context.json({ events: [] });
    const events = await database()
      .db.select()
      .from(table.buildEvent)
      .where(eq(table.buildEvent.runId, buildRuns.at(-1)!))
      .orderBy(desc(table.buildEvent.cursor));
    return context.json({ events });
  });
}
