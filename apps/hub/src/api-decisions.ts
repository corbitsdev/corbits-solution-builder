import type { Hono } from "hono";
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
import { projectDetail } from "./projects.js";
import { buildEvents } from "./engine-ledger.js";
import { abortBuildAttempt, liveBuild, startBuildAttempt, subscribeBuildOutput } from "./build-attempt.js";
import { streamSSE } from "hono/streaming";
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
    // The ledger has decided; a worker still running for that run is stopped
    // now, and the attempt records that ending rather than a failure.
    if (command === "build.cancel" || command === "build.interrupt") abortBuildAttempt(outcome.runId);
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
    return context.json(outcome);
  });

  /**
   * Starts a build attempt through the bounded bridge. Answers as soon as the
   * ledger says the run is running; the worker keeps going and its outcome
   * reaches the ledger on its own, where the events route and the run's state
   * report it. Holding the response for the whole attempt meant a person
   * watched a spinner for up to thirty minutes with nothing they could do.
   */
  api.post("/projects/:projectId/build/start", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as { runId: string; expectedRevision?: number };
    const started = await startBuildAttempt({
      actor: localActor(),
      projectId,
      runId: body.runId,
      ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
    });
    started.attempt.catch((cause) => {
      console.error(`[build] ${started.run.runId}: the attempt could not be settled on the ledger`, cause);
    });
    return context.json({ run: started.run });
  });

  /**
   * A running attempt's output, streamed: when it started, what the worker
   * has written so far, then each chunk as it lands, then `done`. The text is
   * the process's own, in arrival order — the bridge holds the pipes and
   * nothing more, so this is what it can honestly show. `idle` when this host
   * is not running an attempt for the run, which after a host restart is the
   * truth about a run the ledger still calls running.
   */
  api.get("/projects/:projectId/build/live", (context) => {
    const runId = context.req.query("runId") ?? "";
    return streamSSE(context, async (stream) => {
      let id = 0;
      const send = (event: string, data: string) => stream.writeSSE({ event, data, id: String(id++) });
      const live = liveBuild(runId);
      if (!live) {
        await send("idle", "1");
        return;
      }
      await send("begin", JSON.stringify({ startedAt: live.startedAt }));
      if (live.transcript.length > 0) await send("text", JSON.stringify(live.transcript));
      let closed = false;
      const unsubscribe = subscribeBuildOutput(runId, (event) => {
        if (closed) return;
        if (event.type === "text") void send("text", JSON.stringify(event.text));
        else {
          closed = true;
          void send("done", "1");
        }
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) await stream.sleep(15_000).then(() => (closed ? undefined : send("ping", "")));
    });
  });

  api.get("/projects/:projectId/build/events", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, localActor().principalId);
    const buildRuns = detail.runs.filter((run) => run.kind === "build").map((run) => run.id);
    if (buildRuns.length === 0) return context.json({ events: [] });
    const events = await buildEvents(projectId, buildRuns.at(-1)!);
    return context.json({ events });
  });
}
