import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type Stage } from "@solutions-builder/app/ledger";
import { EVALUATED_STAGE } from "@solutions-builder/app/workflows/stage-loop";
import { notFound, HostError } from "./errors.js";
import { projectDetail } from "./projects.js";
import { requestDraft, type PlanDocument } from "./stage-runs.js";
import { evaluationIn, threadTurns } from "./stage-thread.js";
import { stageIterations } from "./hub-executor.js";
import { nextQuestion } from "./questions.js";
import { liveDraft, liveDraftBegun, subscribeLiveDraft } from "./live-drafts.js";
import { localActor } from "./hub-client.js";

/** The stage 6 documents a request names, refused rather than guessed when one is not a document. */
function planDocumentsIn(names: unknown[]): PlanDocument[] {
  return names.map((name) => {
    if (name === "requirements" || name === "plan") return name;
    throw new HostError("validation_failed", `Stage 6 has no document called ${JSON.stringify(String(name))}.`);
  });
}


export function registerStageRoutes(api: Hono) {
  /** The conversation with a stage specialist, oldest turn first. */
  api.get("/projects/:projectId/stages/:stage/thread", async (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage"));
    const open = await nextQuestion(projectId, stage);
    const evaluation =
      stage === EVALUATED_STAGE ? await evaluationIn(await stageIterations(projectId, stage as Stage)) : null;
    return context.json({
      turns: await threadTurns(projectId, stage),
      open: open ? { remaining: open.remaining, ordinal: open.ordinal } : null,
      evaluation,
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
      else if (liveDraftBegun(projectId, stage)) await send("begin", "1");
      let closed = false;
      const unsubscribe = subscribeLiveDraft(projectId, stage, (event) => {
        if (closed) return;
        void (event.type === "text"
          ? send("text", JSON.stringify(event.text))
          : send(event.type, "1"));
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
   * Answering an outstanding question asks the next one: the round revises
   * the document against the answer just given (`mode: "interview"`), but the
   * specialist's own turn stays silent — the thread projection speaks the
   * next queued question, not a fresh one. Only when the questions run out —
   * or the person says to move on — is the round a `final` one, opening a
   * new round of questions or none. Which case this is is known before the
   * round runs: `open.remaining` already says how many questions are left
   * after the one just answered.
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
    const detail = await projectDetail(projectId, localActor().principalId);
    if (!detail.current) throw notFound("An open run for that project");
    const message = (body.message ?? "").trim();
    const quotes = body.quotes ?? [];

    const open = body.revise ? null : await nextQuestion(projectId, stage);
    const mode = open !== null && message.length > 0 && open.remaining > 0 ? "interview" : "final";

    const result = await requestDraft({
      projectId,
      stage,
      runId: detail.current.id,
      actor: localActor(),
      message,
      ...(quotes.length > 0 ? { quotes } : {}),
      mode,
      projectTitle: detail.project.title,
    });

    if (mode === "interview") {
      const following = await nextQuestion(projectId, stage);
      return context.json({ asked: true, remaining: following?.remaining ?? 0, draft: result.draft, ...(result.note !== undefined ? { note: result.note } : {}) });
    }
    return context.json({ asked: false, remaining: 0, draft: result.draft, ...(result.note !== undefined ? { note: result.note } : {}) });
  });

  /** Runs the stage specialist and records its draft as a new version. */
  api.post("/projects/:projectId/stages/:stage/draft", async (context) => {
    const projectId = context.req.param("projectId");
    const stage = Number(context.req.param("stage")) as Stage;
    const body = (await context.req.json().catch(() => ({}))) as {
      input?: string;
      quotes?: { quote: string }[];
      /** Stage 5: write these stakeholders' packages only, by name. */
      audiences?: string[];
      /** Stage 6: write the requirements, the plan, or both; absent, whatever the stage lacks. */
      documents?: string[];
    };
    const detail = await projectDetail(projectId, localActor().principalId);
    if (!detail.current) throw notFound("An open run for that project");

    const result = await requestDraft({
      projectId,
      stage,
      runId: detail.current.id,
      actor: localActor(),
      message: body.input ?? "",
      ...(body.quotes && body.quotes.length > 0 ? { quotes: body.quotes } : {}),
      mode: "final",
      projectTitle: detail.project.title,
      ...(Array.isArray(body.audiences) ? { audiences: body.audiences.map(String) } : {}),
      ...(Array.isArray(body.documents) ? { documents: planDocumentsIn(body.documents) } : {}),
    });

    // Stage 5 fans out into one package per named audience, and says which
    // could not be written; stage 6 writes its requirements and then the
    // architect's plan with the four panel reviews. Every other stage
    // carries none of these.
    return context.json({
      draft: result.draft,
      ...(result.note !== undefined ? { note: result.note } : {}),
      packages: result.packages,
      review: result.review,
      requirements: result.requirements,
      ...(result.failed ? { failed: result.failed } : {}),
    });
  });
}
