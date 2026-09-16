/**
 * The stage conversation, projected from the run itself.
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
 * Resolving an agent step's output ref can mean a network call (a reply that
 * spilled to a blob), so this module is not fully pure — but the round's own
 * payload never does: it is small and structured, so it is read straight off
 * `SignalReceived.payload` with no ref indirection, and every other read here
 * is a one-line `readOutputRef` await. `hub-executor.ts` owns every import of
 * the Interchange platform itself; this file only calls the plain functions
 * it exports.
 *
 * `threadTurns` is the assembled read a route or `questions.ts` actually
 * wants: it gathers the iterations, the project's own artifact nodes (for
 * `resultNodeId`) and, at stage 1, the opening problem statement recorded on
 * the `project.create` command, and hands them to `projectStageThread`. That
 * is the one place in this file that reads the app's own tables rather than
 * the run's event log; it is still nothing this file writes.
 */
import {
  DRAFT_STEP_ID,
  EVALUATE_STEP_ID,
  REQUIREMENTS_STEP_ID,
  ROUND_STEP_ID,
} from "@solutions-builder/app/workflows/stage-loop";
import type { Stage } from "@solutions-builder/app/ledger";
import { briefVerdictIn, questionsIn, summaryIn } from "@solutions-builder/app/document";
import type { HubRunEvent } from "./hub-client.js";
import { readOutputRef, stageIterations, type StageIteration } from "./hub-executor.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { eq } from "drizzle-orm";
import { carriedTurns, ledgerCommands } from "./engine-ledger.js";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";

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

/** The anchor (deployment) run id an iteration's own run id was minted under. */
function anchorOf(iterationRunId: string): string {
  return iterationRunId.split("__", 1)[0]!;
}

function eventBody(event: HubRunEvent): Record<string, unknown> {
  return event.body;
}

function findEvent(
  events: HubRunEvent[],
  kind: string,
  stepId?: string,
): HubRunEvent | undefined {
  return events.find(
    (event) => event.type === kind && (stepId === undefined || eventBody(event).stepId === stepId),
  );
}

async function resolveOutput<T>(iterationRunId: string, event: HubRunEvent | undefined): Promise<T | null> {
  if (!event) return null;
  const output = eventBody(event).output as { ref?: unknown } | undefined;
  if (typeof output?.ref !== "string") return null;
  return (await readOutputRef(anchorOf(iterationRunId), iterationRunId, output.ref)) as T;
}

/** The round's payload: the round step's own output when it has completed, else the signal that will settle it. */
async function roundPayload(iteration: StageIteration): Promise<{ payload: RoundPayload; at: string } | null> {
  const completed = findEvent(iteration.events, "StepCompleted", ROUND_STEP_ID);
  const resolved = await resolveOutput<RoundPayload>(iteration.runId, completed);
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
 * round started — so a question a `revise:true` round abandoned (api-stages
 * forces those to `final`, dropping the rest of the queue) is asked again
 * when the next draft re-emits it. When nothing fresh remains there is no
 * open question. `questions.ts`' `nextQuestion` runs this over the persisted
 * thread; the interview projection below runs it over the turns projected so
 * far.
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
 * specialist turn per iteration, at most, in the shape the stage thread has
 * always had so `questions.ts`' `nextQuestion` and the web client keep
 * working unchanged.
 */
export async function projectStageThread(args: {
  readonly iterations: readonly StageIteration[];
  readonly nodes: readonly ArtifactNodeRef[];
  readonly opening?: { readonly body: string; readonly createdAt: string } | null;
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
    const round = await roundPayload(iteration);
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
    const requirements = await resolveOutput<DraftReply>(iteration.runId, requirementsCompleted);
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
    const reply = await resolveOutput<DraftReply>(iteration.runId, draftCompleted);
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

/** The opening problem statement, projected as stage 1's first human turn — read once, off the `project.create` command. */
async function openingFor(
  projectId: string,
  stage: number,
): Promise<{ body: string; createdAt: string } | null> {
  if (stage !== 1) return null;
  const commands = await ledgerCommands(projectId);
  const opened = commands.find((command) => command.command === "project.create");
  if (!opened || !opened.message) return null;
  return { body: opened.message, createdAt: opened.createdAt };
}

/**
 * The stage thread, assembled: every iteration's turns, the project's live
 * artifact nodes (for `resultNodeId`) and, at stage 1, the opening problem
 * statement. The shape a route or `questions.ts` reads.
 */
export async function threadTurns(projectId: string, stage: number): Promise<StageTurn[]> {
  const { db } = database();
  const [iterations, nodes, opening, carried] = await Promise.all([
    stageIterations(projectId, stage as Stage),
    db
      .select({ id: table.artifactNode.id, provenance: table.artifactNode.provenance })
      .from(table.artifactNode)
      .where(eq(table.artifactNode.projectId, projectId)),
    openingFor(projectId, stage),
    carriedTurns(projectId, stage),
  ]);
  const here = await projectStageThread({ iterations, nodes: nodes as ArtifactNodeRef[], opening });
  if (carried.length === 0) return here;
  // What was carried in happened before anything that ran here; the opening
  // statement, when there is one, came before all of it.
  const [first, ...rest] = here;
  const before = first?.id === "opening" ? [first] : [];
  const after = first?.id === "opening" ? rest : here;
  return [...before, ...(carried as StageTurn[]), ...after];
}

/** The stage's conversation as it can travel: every turn that ran here or was carried here, the opening statement aside since it rides on the ledger. */
export async function portableThread(projectId: string, stage: number): Promise<StageTurn[]> {
  return (await threadTurns(projectId, stage)).filter((turn) => turn.id !== "opening");
}

/** The brief-evaluator verdict one iteration produced, or null when it did not run. */
async function verdictIn(iteration: StageIteration): Promise<{ ready: boolean; notes: string[] } | null> {
  const completed = findEvent(iteration.events, "StepCompleted", EVALUATE_STEP_ID);
  if (!completed) return null;
  const reply = await resolveOutput<DraftReply>(iteration.runId, completed);
  // A step that completed without a reply — an agent step that ended in an
  // error the runtime still records as completion — gave no verdict. The
  // thread must not fail to load over it.
  return typeof reply?.reply === "string" ? briefVerdictIn(reply.reply) : null;
}

/** The latest brief-evaluator verdict for the stage, or null before one has run. */
export async function evaluationIn(
  iterations: readonly StageIteration[],
): Promise<{ ready: boolean; notes: string[] } | null> {
  for (let at = iterations.length - 1; at >= 0; at -= 1) {
    if (findEvent(iterations[at]!.events, "StepCompleted", EVALUATE_STEP_ID)) return verdictIn(iterations[at]!);
  }
  return null;
}
