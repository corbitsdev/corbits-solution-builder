import type { Hono } from "hono";
import { type Stage } from "@solutions-builder/app/ledger";
import { EVALUATED_STAGE } from "@solutions-builder/app/workflows/stage-loop";
import { notFound, HostError } from "./errors.js";
import { projectDetail } from "./projects.js";
import { roundInference, type PlanDocument } from "./stage-runs.js";
import { evaluationIn, threadTurns } from "./stage-thread.js";
import { stageIterations } from "./lifecycle-run.js";
import { commandFrom } from "./api.js";
import { readProject } from "./project-records.js";
import { nextQuestion } from "./questions.js";
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
   *
   * The route only signals: it delivers the round envelope as a `stage.draft`
   * command and returns the delivery outcome. The workflow owns the prompt
   * and the persisted versions from there; the pane learns of them through
   * its own refetch.
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

    const outcome = await commandFrom("stage.draft", projectId, {
      runId: detail.current.id,
      message,
      ...(quotes.length > 0 ? { quotes } : {}),
      mode,
      draft: true,
      inference: await roundInference(stage),
    });

    if (mode === "interview") {
      const following = await nextQuestion(projectId, stage);
      return context.json({ ...outcome, asked: true, remaining: following?.remaining ?? 0 });
    }
    return context.json({ ...outcome, asked: false, remaining: 0 });
  });

  /**
   * Asking the stage specialist for a draft.
   *
   * A thin relay: it validates the request, then delivers the round envelope
   * as a `stage.draft` command and returns the delivery outcome. The prompt
   * is rendered workflow-side from the envelope's message and selectors, and
   * the versions land through the workflow's own persist — the pane learns of
   * them through its own refetch, not through this response.
   */
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

    const audiences = Array.isArray(body.audiences) ? body.audiences.map(String) : undefined;
    if (stage === 5 && audiences) {
      const policy = (await readProject(projectId))?.policy;
      const configured = policy?.audiences.map((entry) => entry.name) ?? [];
      const unknown = audiences.filter((name) => !configured.includes(name));
      if (unknown.length > 0) {
        throw new HostError("validation_failed", `Stage 5 has no audience called ${unknown.map((name) => JSON.stringify(name)).join(", ")}.`);
      }
      if (configured.length === 0) {
        throw new HostError(
          "validation_failed",
          "No audiences named yet at stage 5: the run is still gathering them.",
        );
      }
    }
    const documents = Array.isArray(body.documents) ? planDocumentsIn(body.documents) : undefined;
    if (stage === 6 && documents?.length === 0) {
      throw new HostError(
        "validation_failed",
        "Either name one of the stage 6 documents, or let the draft decide.",
      );
    }

    const outcome = await commandFrom("stage.draft", projectId, {
      runId: detail.current.id,
      message: body.input ?? "",
      ...((body.quotes?.length ?? 0) > 0 ? { quotes: body.quotes } : {}),
      mode: "final",
      draft: true,
      ...(audiences ? { audiences } : {}),
      ...(documents ? { documents } : {}),
      inference: await roundInference(stage),
    });
    return context.json(outcome);
  });
}
