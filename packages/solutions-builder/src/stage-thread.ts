/**
 * The stage conversation, folded from a run's own committed events.
 *
 * Nothing here is written; everything is read. A stage's revise loop is a
 * sequence of iteration child runs, and each iteration's own committed events
 * already carry the round's human message and the specialist's reply — the
 * round step's `StepCompleted` (or, for a round still in flight, the
 * `SignalReceived` that will become it) and the draft step's `StepCompleted`.
 * Projecting the thread is reading that log in order and deciding, per
 * iteration, whether it produced a human turn, a specialist turn, both or
 * neither.
 *
 * This fold is pure over its inputs: the iterations' events, the project's
 * artifact nodes (for `resultNodeId`), the stage-1 opening statement, and an
 * injected `readRef` that resolves a step's output ref to its value — a
 * network call (a reply that spilled to a blob) either the hub or the browser
 * can make the same way, over its own path to Interchange. `apps/hub`'s
 * `stage-thread.ts` binds `readRef` to `lifecycle-run.ts`'s `readOutputRef`
 * and supplies the DB-backed nodes/opening/carried turns; `apps/web`'s
 * `stage-thread.ts` binds it to a blob read over the `/hub` passthrough and
 * supplies the nodes already on `ProjectDetail`. Same rule, two readers.
 */
import { DRAFT_STEP_ID, EVALUATE_STEP_ID, REQUIREMENTS_STEP_ID, ROUND_STEP_ID } from "./workflows/stage-loop.js";
import { briefVerdictIn, questionsIn, summaryIn } from "./document.js";
import type { RunEvent } from "./project-state.js";
import type { Quote, StageTurn } from "./stage-prompt.js";

export type { Quote, StageTurn };

/**
 * How the platform's director words a call it could not complete: it replies
 * with the error in the model's place, and that reply is the step's output.
 * A draft that reads this way is the failure, not a digest.
 */
const PLATFORM_ERROR_OPENINGS = ["This agent could not complete your request", "This agent encountered a temporary error", "This agent's inference request was aborted"];

function isPlatformError(reply: string): boolean {
  return PLATFORM_ERROR_OPENINGS.some((opening) => reply.trimStart().startsWith(opening));
}

/** What a person is told when a round did not complete, with what the platform reported. */
export function failedRoundBody(reported: string | null): string {
  const said = reported?.trim() ? `The platform reported: ${reported.trim().replace(/\.?$/, ".")}` : "The platform did not say why.";
  return `This round did not complete, so nothing was drafted. ${said} Send your message again to run another round. If it keeps happening, check the provider under Settings.`;
}

/** The graph node lookup `resultNodeId` is read from — just enough of the row to match `provenance.stepRef`. */
export type ArtifactNodeRef = { readonly id: string; readonly provenance: { readonly stepRef?: string } };

/** One iteration child run of a stage's revise loop: its id and its own committed events, oldest first. */
export type StageIteration = { readonly runId: string; readonly events: readonly RunEvent[] };

type RoundPayload = {
  readonly command: string;
  readonly draft: boolean;
  readonly message?: string;
  readonly quotes?: Quote[];
  readonly mode?: "interview" | "final";
  readonly prompt?: string;
  readonly prompts?: string[];
  readonly brief?: string;
};

type DraftReply = { readonly reply: string };

/** Resolves a step output ref to the value it names, for one iteration's anchor and run. */
export type OutputResolver = (anchorRunId: string, runId: string, ref: string) => Promise<unknown>;

/** The anchor (deployment) run id an iteration's own run id was minted under. */
function anchorOf(iterationRunId: string): string {
  return iterationRunId.split("__", 1)[0]!;
}

function eventBody(event: RunEvent): Record<string, unknown> {
  return event.body;
}

function findEvent(events: readonly RunEvent[], kind: string, stepId?: string): RunEvent | undefined {
  return events.find((event) => event.type === kind && (stepId === undefined || eventBody(event).stepId === stepId));
}

async function resolveOutput<T>(iterationRunId: string, event: RunEvent | undefined, readRef: OutputResolver): Promise<T | null> {
  if (!event) return null;
  const output = eventBody(event).output as { ref?: unknown } | undefined;
  if (typeof output?.ref !== "string") return null;
  return (await readRef(anchorOf(iterationRunId), iterationRunId, output.ref)) as T;
}

/** The round's payload: the round step's own output when it has completed, else the signal that will settle it. */
async function roundPayload(
  iteration: StageIteration,
  readRef: OutputResolver,
): Promise<{ payload: RoundPayload; at: string } | null> {
  const completed = findEvent(iteration.events, "StepCompleted", ROUND_STEP_ID);
  const resolved = await resolveOutput<RoundPayload>(iteration.runId, completed, readRef);
  if (resolved && completed) return { payload: resolved, at: String(eventBody(completed).at) };

  const received = findEvent(iteration.events, "SignalReceived");
  if (!received) return null;
  return { payload: eventBody(received).payload as RoundPayload, at: String(eventBody(received).at) };
}

/**
 * The next open question over already-projected turns: the last specialist
 * turn that carried a list of questions starts a round, and every human turn
 * after it answers the next one. A question an earlier round asked counts as
 * asked only when it was answered there — the human turns before the next
 * round started — so a question a `revise:true` round abandoned (the reply
 * route forces those to `final`, dropping the rest of the queue) is asked
 * again when the next draft re-emits it. When nothing fresh remains there is
 * no open question.
 */
/** One question with case and spacing flattened, so a re-emitted repeat matches the round that asked it. */
function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function nextOpenQuestion(turns: readonly StageTurn[]): {
  readonly body: string;
  readonly ordinal: number;
  readonly remaining: number;
  readonly openerId: string;
} | null {
  let round = -1;
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (turns[at]!.role === "specialist" && turns[at]!.questions !== null) {
      round = at;
      break;
    }
  }
  if (round === -1) return null;
  const opener = turns[round]!;
  const askedBefore = new Set<string>();
  const openers: number[] = [];
  for (let at = 0; at <= round; at += 1) {
    if (turns[at]!.role === "specialist" && turns[at]!.questions !== null) openers.push(at);
  }
  for (let roundIndex = 0; roundIndex + 1 < openers.length; roundIndex += 1) {
    const start = openers[roundIndex]!;
    const end = openers[roundIndex + 1]!;
    const answered = turns.slice(start + 1, end).filter((turn) => turn.role === "human").length;
    for (const asked of (turns[start]!.questions ?? []).slice(0, answered)) askedBefore.add(normalizeQuestion(asked));
  }
  const fresh = (opener.questions ?? []).filter((asked) => !askedBefore.has(normalizeQuestion(asked)));
  const answered = turns.slice(round + 1).filter((turn) => turn.role === "human").length;
  const body = fresh[answered];
  if (body === undefined) return null;
  return { body, ordinal: answered, remaining: fresh.length - answered - 1, openerId: opener.id };
}

/**
 * The next open question of the interview round already under way — the
 * shared count above, so a repeat the model re-emitted is not spoken again
 * while its answer stands two rounds back. Nothing fresh left means nothing
 * to ask, and the turn says so.
 */
function nextInterviewQuestion(turnsSoFar: StageTurn[]): string {
  return nextOpenQuestion(turnsSoFar)?.body ?? "Anything to change before you approve it?";
}

/**
 * The stage thread, read straight from the run: one human turn and one
 * specialist turn per iteration, at most.
 */
export async function projectStageThread(args: {
  readonly iterations: readonly StageIteration[];
  readonly nodes: readonly ArtifactNodeRef[];
  readonly opening?: { readonly body: string; readonly createdAt: string } | null;
  readonly readRef: OutputResolver;
}): Promise<StageTurn[]> {
  const turns: StageTurn[] = [];

  if (args.opening) {
    turns.push({
      id: "opening",
      role: "human",
      body: args.opening.body,
      quotes: [],
      resultNodeId: null,
      questions: null,
      createdAt: args.opening.createdAt,
    });
  }

  for (const iteration of args.iterations) {
    const round = await roundPayload(iteration, args.readRef);
    if (round && ((round.payload.message ?? "").trim().length > 0 || (round.payload.quotes?.length ?? 0) > 0)) {
      turns.push({
        id: `${iteration.runId}:round`,
        role: "human",
        body: round.payload.message ?? "",
        quotes: round.payload.quotes ?? [],
        resultNodeId: null,
        questions: null,
        createdAt: round.at,
      });
    }

    // A round that asked for nothing (a non-drafting command reached this
    // iteration) or that failed to draft leaves no specialist turn.
    if (!round || !round.payload.draft) continue;

    // Stage 6 writes its requirements in a round of their own, ahead of the
    // plan. That round has no draft to speak for, so the requirements say
    // once that they are there; the questions, if any, come with the plan.
    const requirementsCompleted = findEvent(iteration.events, "StepCompleted", REQUIREMENTS_STEP_ID);
    const requirements = await resolveOutput<DraftReply>(iteration.runId, requirementsCompleted, args.readRef);
    if (requirementsCompleted && typeof requirements?.reply === "string") {
      turns.push({
        id: `${iteration.runId}:requirements`,
        role: "specialist",
        body: "The product requirements are beside this: what stages 1 to 4 agreed, gathered into the one document the plan is written against.",
        quotes: [],
        resultNodeId:
          args.nodes.find((node) => node.provenance.stepRef === `${iteration.runId}/${REQUIREMENTS_STEP_ID}`)?.id ?? null,
        questions: null,
        createdAt: String(eventBody(requirementsCompleted).at),
      });
    }

    // A round whose draft step failed is still a turn: the person waited on
    // it, and the thread is the one place they would learn what happened.
    const draftFailed = findEvent(iteration.events, "StepFailed", DRAFT_STEP_ID);
    if (draftFailed) {
      const error = eventBody(draftFailed).error as { message?: string } | undefined;
      turns.push({
        id: `${iteration.runId}:failed`,
        role: "specialist",
        body: failedRoundBody(typeof error?.message === "string" ? error.message : null),
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: String(eventBody(draftFailed).at),
        failed: true,
      });
      continue;
    }

    // A step the round's gate skipped completes with a sentinel and no reply;
    // it is not a draft.
    const draftCompleted = findEvent(iteration.events, "StepCompleted", DRAFT_STEP_ID);
    const reply = await resolveOutput<DraftReply>(iteration.runId, draftCompleted, args.readRef);
    if (!draftCompleted || typeof reply?.reply !== "string") continue;

    if (isPlatformError(reply.reply)) {
      turns.push({
        id: `${iteration.runId}:failed`,
        role: "specialist",
        body: failedRoundBody(reply.reply),
        quotes: [],
        resultNodeId: null,
        questions: null,
        createdAt: String(eventBody(draftCompleted).at),
        failed: true,
      });
      continue;
    }

    const resultNodeId =
      args.nodes.find((node) => node.provenance.stepRef === `${iteration.runId}/${DRAFT_STEP_ID}`)?.id ?? null;
    const createdAt = String(eventBody(draftCompleted).at);

    if (round.payload.mode === "interview") {
      turns.push({
        id: `${iteration.runId}:draft`,
        role: "specialist",
        body: nextInterviewQuestion(turns),
        quotes: [],
        resultNodeId,
        questions: null,
        createdAt,
      });
      continue;
    }

    const asked = questionsIn(reply.reply);
    const body = asked[0]
      ? `The draft is beside this. Before I revise it:\n\n${asked[0]}`
      : `${summaryIn(reply.reply) ?? "Here is the revised draft."}\n\nAnything to change before you approve it?`;
    turns.push({
      id: `${iteration.runId}:draft`,
      role: "specialist",
      body,
      quotes: [],
      resultNodeId,
      questions: asked,
      createdAt,
    });
  }

  return turns;
}

/** The brief-evaluator verdict one iteration produced, or null when it did not run. */
async function verdictIn(iteration: StageIteration, readRef: OutputResolver): Promise<{ ready: boolean; notes: string[] } | null> {
  const completed = findEvent(iteration.events, "StepCompleted", EVALUATE_STEP_ID);
  if (!completed) return null;
  const reply = await resolveOutput<DraftReply>(iteration.runId, completed, readRef);
  // A step that completed without a reply — an agent step that ended in an
  // error the runtime still records as completion — gave no verdict. The
  // thread must not fail to load over it.
  return typeof reply?.reply === "string" ? briefVerdictIn(reply.reply) : null;
}

/** The latest brief-evaluator verdict for the stage, or null before one has run. */
export async function evaluationIn(
  iterations: readonly StageIteration[],
  readRef: OutputResolver,
): Promise<{ ready: boolean; notes: string[] } | null> {
  for (let at = iterations.length - 1; at >= 0; at -= 1) {
    if (findEvent(iterations[at]!.events, "StepCompleted", EVALUATE_STEP_ID)) return verdictIn(iterations[at]!, readRef);
  }
  return null;
}
