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
import { ledgerCommands } from "./engine-ledger.js";

export type Quote = { readonly quote: string };

export type StageTurn = {
  readonly id: string;
  readonly role: "human" | "specialist";
  readonly body: string;
  readonly quotes: Quote[];
  readonly resultNodeId: string | null;
  /** The questions a specialist turn opened a round with; null on every other turn. */
  readonly questions: string[] | null;
  readonly createdAt: string;
};

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
 * The next open question of the interview round already under way — the
 * same count `questions.ts`' `nextQuestion` runs over a persisted thread,
 * run here over the turns projected so far.
 */
function nextInterviewQuestion(turnsSoFar: StageTurn[]): string {
  let openerAt = -1;
  for (let at = turnsSoFar.length - 1; at >= 0; at -= 1) {
    if (turnsSoFar[at]!.role === "specialist" && turnsSoFar[at]!.questions !== null) {
      openerAt = at;
      break;
    }
  }
  if (openerAt === -1) return "Anything to change before you approve it?";
  const opener = turnsSoFar[openerAt]!;
  const questions = opener.questions ?? [];
  const answered = turnsSoFar.slice(openerAt + 1).filter((entry) => entry.role === "human").length;
  return questions[answered] ?? questions.at(-1) ?? "Anything to change before you approve it?";
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

    if (findEvent(iteration.events, "StepFailed", DRAFT_STEP_ID)) continue;

    // A step the round's gate skipped completes with a sentinel and no reply;
    // it is not a draft.
    const draftCompleted = findEvent(iteration.events, "StepCompleted", DRAFT_STEP_ID);
    const reply = await resolveOutput<DraftReply>(iteration.runId, draftCompleted);
    if (!draftCompleted || typeof reply?.reply !== "string") continue;

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
  const [iterations, nodes, opening] = await Promise.all([
    stageIterations(projectId, stage as Stage),
    db
      .select({ id: table.artifactNode.id, provenance: table.artifactNode.provenance })
      .from(table.artifactNode)
      .where(eq(table.artifactNode.projectId, projectId)),
    openingFor(projectId, stage),
  ]);
  return projectStageThread({ iterations, nodes: nodes as ArtifactNodeRef[], opening });
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
