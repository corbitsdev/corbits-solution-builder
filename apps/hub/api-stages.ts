import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type Stage } from "@solutions-builder/app/ledger";
import { notFound } from "./errors.js";
import { projectDetail } from "./projects.js";
import { draftAudiencePackages, draftStageArtifact, runEngineeringReview } from "./agent-run.js";
import { appendHumanTurn, appendSpecialistTurn, threadTurns } from "./hub-conversation.js";
import { nextQuestion } from "./questions.js";
import { liveDraft, liveDraftBegun, subscribeLiveDraft } from "./live-drafts.js";
import { LOCAL_ACTOR } from "./api.js";

export function registerStageRoutes(api: Hono) {
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
      void messageId;

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

    // Nothing left to ask, or the person chose to move on: fold everything
    // said into one new version. The new draft opens a new round, which is
    // what retires whatever was left of the old one.
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
}
