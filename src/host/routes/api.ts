/**
 * The versioned local Hub API.
 *
 * Every client — the Tauri window, the tray, a later CLI — consumes only this.
 * That is what makes the cloud move in PRD section 5 an endpoint change rather
 * than a rewrite, and it is why no route here reaches into a React component's
 * assumptions.
 *
 * Two invariants the route layer owns:
 *   - external input is validated once, here, at the boundary that owns it;
 *   - no response body ever contains a secret.
 */
import { rm, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";
import { desc, eq } from "drizzle-orm";
import { startAtLoginMarker } from "../paths.js";
import {
  AudienceDecidePayload,
  BuildAnswerPayload,
  BuildFreezePayload,
  CostApprovePayload,
  DeliveryDecisionPayload,
  ProjectCreatePayload,
  ProviderConnectRequest,
  RoutePayload,
  SoloDecidePayload,
  StageApprovePayload,
} from "../../contracts/domain.js";
import {
  COMMANDS,
  LEDGER,
  STAGE_TITLES,
  type Command,
  type Stage,
  type RunState,
} from "../../contracts/ledger.js";
import { execute, submitAndApprove } from "../engine.js";
import { HostError, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { database } from "../db/client.js";
import * as table from "../db/schema.js";
import {
  artifactGraph,
  createProject,
  listProjects,
  openDecisions,
  projectDetail,
  readArtifactNode,
  renameProject,
  archiveProject,
  deleteProject,
} from "../store/projects.js";
import {
  draftAudiencePackages,
  draftStageArtifact,
  redesignFromFeedback,
  runEngineeringReview,
} from "../../orchestration/agents/run.js";
import {
  designHistory,
  feedbackFor,
  submitFeedback,
  type Direction,
} from "../store/design-feedback.js";
import { appendHumanTurn, appendSpecialistTurn, threadTurns } from "../hub/conversation.js";
import { nameProject, titleFromProblem } from "../../orchestration/agents/title.js";
import { answerQuestion, nextQuestion, retireQuestions } from "../store/questions.js";
import { liveDraft, subscribeLiveDraft } from "../store/live-drafts.js";
import { runGuidance } from "../../orchestration/agents/guide.js";
import { AGENT_KIT } from "../../orchestration/agents/kit.js";
import {
  API_KEY_PROVIDERS,
  OAUTH_CANDIDATES,
  connectProvider,
  disconnectProvider,
  listProviders,
  selectModel,
  startOAuthConnect,
  finishOAuthConnect,
  refreshProviderModels,
  setProviderOrder,
} from "../../orchestration/providers/registry.js";
import { cancelLogin, loginInFlight } from "../../orchestration/providers/oauth.js";
import { credentialBackend } from "../../orchestration/providers/credentials.js";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_ID,
  bridgeAvailable,
  runBuildAttempt,
} from "../../orchestration/bridge/corbits-exec.js";
import { drainOutbox } from "../outbox.js";
import { hostStatus, requestHostStop } from "../lifecycle.js";
import { ensureHub, hubFetch } from "../hub/endpoint.js";

export const API_VERSION = "1";

/**
 * The local single-user actor. When hosted mode arrives this is resolved from
 * the session instead; every call site already reads it from one place.
 */
const LOCAL_ACTOR = { principalId: "p_owner", displayName: "You" };

function parsed<T>(result: T | type.errors): T {
  if (result instanceof type.errors) {
    throw new HostError("validation_failed", result.summary);
  }
  return result;
}

async function commandFrom(
  type_: Command,
  projectId: string,
  payload: Record<string, unknown>,
) {
  return execute({
    type: type_,
    actor: LOCAL_ACTOR,
    projectId,
    idempotencyKey: (payload.idempotencyKey as string) ?? newId.command(),
    correlationId: newId.correlation(),
    // §6: a caller that has read the project says which revision it read, and
    // a decision taken against a stale one is refused rather than applied.
    ...(typeof payload.expectedRevision === "number"
      ? { expectedRevision: payload.expectedRevision }
      : {}),
    payload,
  });
}

/**
 * What the interface says about the hub. `mode` is the whole point of the
 * seam: the same product runs against an embedded hub today and a hosted one
 * later, and this is where that becomes visible rather than implied.
 */
async function hubSummary() {
  const endpoint = await ensureHub().catch((cause: unknown) => ({
    mode: "embedded" as const,
    url: null,
    ready: false,
    detail: cause instanceof Error ? cause.message : "The hub did not start.",
  }));

  // The hub reports its own health; this host does not vouch for it.
  const status = await hubFetch("/status")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  return {
    mode: endpoint.mode,
    url: endpoint.url,
    ready: endpoint.ready && status !== null,
    detail: endpoint.detail,
    reported: status,
  };
}

export function createApi() {
  const api = new Hono();

  api.get("/status", async (context) => {
    const providers = await listProviders();
    const bridge = await bridgeAvailable();
    return context.json({
      apiVersion: API_VERSION,
      host: hostStatus(),
      credentialBackend: await credentialBackend(),
      inference: {
        connected: providers.some((provider) => provider.status === "ready"),
        active: providers.find((provider) => provider.active)?.providerId ?? null,
      },
      hub: await hubSummary(),
      build: {
        // Named honestly: this is the bounded bridge, not shared-hub supervision.
        integration: BRIDGE_ID,
        available: bridge.available,
        detail: bridge.detail,
        capabilities: BRIDGE_CAPABILITIES,
      },
    });
  });

  /** The ledger, served to clients so labels and available actions agree with it. */
  api.get("/ledger", (context) =>
    context.json({
      commands: COMMANDS,
      stages: Object.entries(STAGE_TITLES).map(([stage, title]) => ({
        stage: Number(stage),
        title,
      })),
      transitions: LEDGER,
    }),
  );

  api.get("/agents", (context) =>
    context.json({
      agents: AGENT_KIT.map((agent) => ({
        id: agent.id,
        title: agent.title,
        mission: agent.mission,
        stages: agent.stages,
        produces: agent.produces,
        promptKey: agent.promptKey,
        boundary: agent.boundary,
      })),
    }),
  );

  api.get("/providers", async (context) =>
    context.json({
      // `hasCredential` is a boolean. The secret itself has no route.
      providers: await listProviders(),
      apiKeyProviders: API_KEY_PROVIDERS,
      oauthCandidates: OAUTH_CANDIDATES,
    }),
  );

  api.post("/providers", async (context) => {
    const request = parsed(ProviderConnectRequest(await context.req.json()));
    const provider = await connectProvider(request);
    return context.json({ provider });
  });

  /**
   * Starts a browser sign-in. Returns the authorize URL so the UI can offer it
   * as a copyable link when the browser could not be launched.
   */
  api.post("/providers/oauth/:providerId/start", async (context) =>
    context.json(await startOAuthConnect(context.req.param("providerId"))),
  );

  /** Waits for the loopback callback and records the connection. */
  api.post("/providers/oauth/finish", async (context) =>
    context.json({ provider: await finishOAuthConnect() }),
  );

  api.post("/providers/oauth/cancel", async (context) => {
    cancelLogin();
    return context.json({ cancelled: true });
  });

  api.get("/providers/oauth/status", (context) =>
    context.json({ inFlight: loginInFlight() }),
  );

  api.put("/providers/order", async (context) => {
    const body = (await context.req.json()) as { providerIds?: string[] };
    if (!Array.isArray(body.providerIds)) {
      throw new HostError("validation_failed", "Send the provider ids in their new order.");
    }
    return context.json({ providers: await setProviderOrder(body.providerIds) });
  });

  api.post("/providers/:providerId/refresh", async (context) =>
    context.json({ provider: await refreshProviderModels(context.req.param("providerId")) }),
  );

  api.put("/providers/:providerId/model", async (context) => {
    const body = (await context.req.json()) as { model?: string };
    if (!body.model) throw new HostError("validation_failed", "Name a model.");
    const provider = await selectModel(context.req.param("providerId"), body.model);
    return context.json({ provider });
  });

  api.delete("/providers/:providerId", async (context) => {
    await disconnectProvider(context.req.param("providerId"));
    return context.json({ ok: true });
  });

  api.get("/decisions", async (context) =>
    context.json({ decisions: await openDecisions() }),
  );

  api.get("/projects", async (context) => context.json({ projects: await listProjects() }));

  api.post("/projects", async (context) => {
    const payload = parsed(ProjectCreatePayload(await context.req.json()));
    const problem = payload.problemStatement?.trim() ?? "";

    // Opened with the plain first line so a project exists whether or not a
    // model is reachable; the real name follows below.
    const created = await createProject({
      title: payload.title || titleFromProblem(problem),
      policy: payload.policy,
      owner: LOCAL_ACTOR,
    });

    if (problem.length > 0) {
      // What they typed IS the first thing they said. It used to be accepted
      // and dropped — the signature took it, nothing wrote it — so stage 1
      // opened by asking for the problem they had just described.
      // Not best effort. What somebody typed is the thing this project is
      // about, and a `.catch` that logs is precisely how it went missing
      // before — the write failed, a line went to a console nobody reads, and
      // stage 1 asked for the problem again as if they had never spoken. If
      // this cannot be recorded the create fails and says so, because a
      // project that has forgotten its own problem is worse than no project.
      await appendHumanTurn({
        projectId: created.projectId,
        branchId: created.branchId,
        runId: created.runId,
        stage: 1,
        body: problem,
        actor: LOCAL_ACTOR,
      });

      // A name for the thing, not a sentence about the person. Best effort and
      // never blocking: a project that will not open because a model is busy
      // is a far worse failure than a plainly-named one.
      await nameProject(problem)
        .then((name) => renameProject(created.projectId, name))
        .catch((cause: unknown) => {
          console.error("[projects] the project kept its opening name:", cause);
        });
    }

    return context.json(created, 201);
  });

  api.get("/projects/:projectId", async (context) =>
    context.json(await projectDetail(context.req.param("projectId"), LOCAL_ACTOR.principalId)),
  );

  /** Stage 4: the design history and any feedback already recorded on it. */
  api.get("/projects/:projectId/design", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const designs = await designHistory(projectId, detail.project.activeBranchId ?? "");
    const feedback = await Promise.all(
      designs.map(async (design) => ({
        designNodeId: design.id,
        ...(await feedbackFor(design.id)),
      })),
    );
    return context.json({ designs, feedback });
  });

  /** Submits immutable feedback and returns the deterministic revision prompt. */
  api.post("/projects/:projectId/design/feedback", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as {
      designNodeId: string;
      direction: Direction;
      overallNote?: string;
      comments?: { anchor: Record<string, unknown>; body: string }[];
      acceptanceCriteria?: string[];
    };
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const result = await submitFeedback({
      projectId,
      branchId: detail.project.activeBranchId ?? "",
      designNodeId: body.designNodeId,
      direction: body.direction,
      overallNote: body.overallNote ?? "",
      comments: body.comments ?? [],
      author: LOCAL_ACTOR.principalId,
      ...(body.acceptanceCriteria ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
    });
    return context.json(result);
  });

  /** Regenerates the design from recorded feedback, and carries dispositions forward. */
  api.post("/projects/:projectId/design/revise", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as { designNodeId: string };
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    if (!detail.current) throw notFound("An open run for that project");
    const result = await redesignFromFeedback({
      projectId,
      branchId: detail.project.activeBranchId ?? "",
      designNodeId: body.designNodeId,
      runId: detail.current.id,
      actor: LOCAL_ACTOR,
      projectTitle: detail.project.title,
    });
    return context.json(result);
  });

  api.get("/projects/:projectId/graph", async (context) =>
    context.json(await artifactGraph(context.req.param("projectId"))),
  );

  api.get("/artifacts/:nodeId", async (context) =>
    context.json(await readArtifactNode(context.req.param("nodeId"))),
  );

  /**
   * Orientation from the Product guide — read-only, and never a transition.
   *
   * Falls back to the deterministic checklist rather than failing: "what do I
   * do now" has to be answerable even when no provider will answer it.
   */
  api.get("/projects/:projectId/guidance", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
    const versions = await Promise.all(
      live.map(async (node) => ({
        id: node.id,
        title: node.title,
        stage: node.stage,
        content: (await readArtifactNode(node.id).catch(() => ({ content: "" }))).content,
      })),
    );
    const policy = detail.project.policy as { audienceQuorum?: number };
    const decisions = detail.approvals.filter(
      (approval) => approval.command === "audience.decide",
    );
    return context.json({
      guidance: await runGuidance({
        projectTitle: detail.project.title,
        stage: detail.current?.stage ?? 1,
        state: (detail.current?.state ?? null) as RunState | null,
        versions,
        approvals: detail.approvals.map((approval) => ({
          stage: approval.stage,
          command: approval.command,
          decision: approval.decision,
        })),
        ...(detail.current?.stage === 5
          ? {
              quorum: {
                recorded: decisions.length,
                needed: policy.audienceQuorum ?? 0,
                blocked: decisions.filter((approval) => approval.decision !== "proceed").length,
              },
            }
          : {}),
      }),
    });
  });

  /** Housekeeping on a project: its name, whether it is filed away, and removal. */
  api.patch("/projects/:projectId", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const body = (await context.req.json().catch(() => ({}))) as { title?: string; archived?: boolean };
    const title = body.title?.trim();
    if (title !== undefined) {
      if (title.length === 0) throw new HostError("validation_failed", "A project needs a name.", {}, false);
      await renameProject(projectId, title.slice(0, 120));
    }
    if (typeof body.archived === "boolean") await archiveProject(projectId, body.archived);
    return context.json({ ok: true });
  });

  api.delete("/projects/:projectId", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, LOCAL_ACTOR.principalId);
    await deleteProject(projectId);
    return context.json({ ok: true });
  });

  /** The conversation with a stage specialist, oldest turn first. */
  api.get("/projects/:projectId/stages/:stage/thread", async (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage"));
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const branchId = detail.project.activeBranchId ?? "";
    const open = await nextQuestion(projectId, branchId, stage);
    return context.json({
      turns: await threadTurns(projectId, branchId, stage),
      open: open ? { remaining: open.remaining, ordinal: open.ordinal } : null,
    });
  });

  /**
   * The draft as it is being written, streamed. Sends what exists on connect,
   * then every update, then `done`; stays open across drafts on the stage.
   */
  api.get("/projects/:projectId/stages/:stage/live", (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage"));
    return streamSSE(context, async (stream) => {
      let id = 0;
      const send = (event: string, data: string) => stream.writeSSE({ event, data, id: String(id++) });
      const current = liveDraft(projectId, stage);
      if (current !== null) await send("text", JSON.stringify(current));
      let closed = false;
      const unsubscribe = subscribeLiveDraft(projectId, stage, (event) => {
        if (closed) return;
        void (event.type === "text" ? send("text", JSON.stringify(event.text)) : send("done", "1"));
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) await stream.sleep(15_000).then(() => (closed ? undefined : send("ping", "")));
    });
  });

  /**
   * Replying in the conversation.
   *
   * Answering an outstanding question asks the next one, which costs nothing:
   * no model call and no new draft. Only when the questions run out — or the
   * person says to move on — is the document revised, once, against every
   * answer given. Six questions become six exchanges rather than six redrafts.
   */
  api.post("/projects/:projectId/stages/:stage/reply", async (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage")) as Stage;
    const body = (await context.req.json().catch(() => ({}))) as {
      message?: string;
      quotes?: { quote: string }[];
      /** Set when the person chooses to stop answering and revise now. */
      revise?: boolean;
    };
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    if (!detail.current) throw notFound("An open run for that project");
    const branchId = detail.project.activeBranchId ?? "";
    const message = (body.message ?? "").trim();
    const quotes = body.quotes ?? [];

    const open = body.revise ? null : await nextQuestion(projectId, branchId, stage);

    if (open && message.length > 0) {
      const messageId = await appendHumanTurn({
        projectId,
        branchId,
        runId: detail.current.id,
        stage,
        body: message,
        actor: LOCAL_ACTOR,
        ...(quotes.length > 0 ? { quotes } : {}),
      });
      await answerQuestion(open.id, messageId);

      const following = await nextQuestion(projectId, branchId, stage);
      if (following) {
        // The document grows with the answer, before the next question is
        // asked. It used to sit untouched until the last one, so a person
        // answered five questions and watched nothing happen — the whole
        // premise is that this is being written as they talk.
        const revised = await draftStageArtifact({
          projectId,
          branchId,
          stage,
          runId: detail.current.id,
          actor: LOCAL_ACTOR,
          userInput: "",
          projectTitle: detail.project.title,
          mode: "interview",
        });

        await appendSpecialistTurn({
          projectId,
          branchId,
          runId: detail.current.id,
          stage,
          body: following.body,
          actor: LOCAL_ACTOR,
          resultNodeId: revised.nodeId,
        });
        return context.json({ asked: true, remaining: following.remaining, draft: revised });
      }
    }

    // Nothing left to ask: fold everything said into one new version.
    if (body.revise) await retireQuestions(projectId, branchId, stage);
    const draft = await draftStageArtifact({
      projectId,
      branchId,
      stage,
      runId: detail.current.id,
      actor: LOCAL_ACTOR,
      userInput: open ? "" : message,
      projectTitle: detail.project.title,
      ...(quotes.length > 0 && !open ? { quotes } : {}),
    });
    return context.json({ asked: false, remaining: 0, draft });
  });

  /** Runs the stage specialist and records its draft as a new version. */
  api.post("/projects/:projectId/stages/:stage/draft", async (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage")) as Stage;
    const body = (await context.req.json().catch(() => ({}))) as {
      input?: string;
      quotes?: { quote: string }[];
    };
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    if (!detail.current) throw notFound("An open run for that project");

    // Stage 5 fans out: one package per named audience.
    if (stage === 5) {
      const policy = detail.project.policy as {
        audiences?: { name: string; role: string }[];
      };
      const packages = await draftAudiencePackages({
        projectId,
        branchId: detail.project.activeBranchId ?? "",
        runId: detail.current.id,
        actor: LOCAL_ACTOR,
        projectTitle: detail.project.title,
        audiences: policy.audiences ?? [],
        userInput: body.input ?? "",
      });
      return context.json({ draft: packages[0], packages, review: null });
    }

    const result = await draftStageArtifact({
      projectId,
      branchId: detail.project.activeBranchId ?? "",
      stage,
      runId: detail.current.id,
      actor: LOCAL_ACTOR,
      userInput: body.input ?? "",
      projectTitle: detail.project.title,
      ...(body.quotes && body.quotes.length > 0 ? { quotes: body.quotes } : {}),
    });

    // Stage 6 gets its four independent reviews against the plan just written.
    // Four principals, four artifacts — never merged into one voice (section 8).
    let review: Awaited<ReturnType<typeof runEngineeringReview>> | null = null;
    if (stage === 6) {
      review = await runEngineeringReview({
        projectId,
        branchId: detail.project.activeBranchId ?? "",
        runId: detail.current.id,
        actor: LOCAL_ACTOR,
        projectTitle: detail.project.title,
        plan: result.content,
      });
    }

    return context.json({ draft: result, review });
  });

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
      actor: LOCAL_ACTOR,
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

    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
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
    const detail = await projectDetail(projectId, LOCAL_ACTOR.principalId);
    const buildRuns = detail.runs.filter((run) => run.kind === "build").map((run) => run.id);
    if (buildRuns.length === 0) return context.json({ events: [] });
    const events = await database()
      .db.select()
      .from(table.buildEvent)
      .where(eq(table.buildEvent.runId, buildRuns.at(-1)!))
      .orderBy(desc(table.buildEvent.cursor));
    return context.json({ events });
  });

  api.post("/host/stop", async (context) => {
    // An explicit host stop, distinct from closing a window.
    requestHostStop();
    return context.json({ stopping: true });
  });

  api.get("/preferences", async (context) => {
    const rows = await database().db.select().from(table.hostPreference);
    return context.json({
      preferences: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    });
  });

  api.put("/preferences/:key", async (context) => {
    const key = context.req.param("key");
    const value = await context.req.json();

    // §3: start-at-login is explicit and reversible, and the desktop host
    // reads the choice before the database is open, so it is mirrored to a
    // file. Its presence is the opt-in; absence is off.
    if (key === "host.startAtLogin") {
      const marker = startAtLoginMarker();
      if (value === true) await writeFile(marker, "1");
      else await rm(marker, { force: true });
    }
    const { db } = database();
    const [existing] = await db
      .select()
      .from(table.hostPreference)
      .where(eq(table.hostPreference.key, key));
    if (existing) {
      await db
        .update(table.hostPreference)
        .set({ value, updatedAt: new Date() })
        .where(eq(table.hostPreference.key, key));
    } else {
      await db.insert(table.hostPreference).values({ key, value });
    }
    return context.json({ key, value });
  });

  api.onError((cause, context) => {
    const correlationId = newId.correlation();
    if (cause instanceof HostError) {
      return context.json(cause.body(correlationId), cause.status as 400);
    }
    // An unexpected failure gets a safe message and a correlation id; the
    // detail stays in the host log rather than in a client response.
    console.error(`[${correlationId}]`, cause);
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "The host failed to complete that request.",
          correlationId,
          retryable: false,
        },
      },
      500,
    );
  });

  return api;
}

