/**
 * The stage conversation, folded from the chat section's own committed
 * events (CL-8598 lifecycle v4).
 *
 * A stage no longer has its own revise/gate loop with iteration child runs:
 * every person message, for every stage, is one occurrence of the anchor
 * run's single `chat` `onTrigger` section. Each occurrence is a full child
 * run of the section's body workflow (`chatBody()`), and that body's own
 * `route` step output carries the stage the message was for; the stage's
 * specialist step(s) run inside that same occurrence, right after routing.
 *
 * An occurrence's body run id is NOT the loop-body convention
 * (`<anchor>__<loopId>__<index>`, still used for `apps/web/artifact-graph.ts`
 * and nothing here) — an onTrigger occurrence's body run id is
 * `<sectionId>__<eventIndex>` (e.g. `chat__0`, `chat__1`, ...), unprefixed by
 * the anchor run id (verified against
 * `vendor/interchange/packages/workflow/src/runtime/run.ts`'s `runOnTrigger`/
 * `driveSuspendableOccurrence`, and its `on-trigger-run.test.ts` fixtures).
 * The anchor's own events name each occurrence with a `ChildSpawned` event
 * whose `stepId` is the section id (`"chat"`) and whose `childRunId` is that
 * occurrence's run id — so occurrences are discovered by scanning the
 * anchor's own event log for `ChildSpawned{stepId:"chat"}`, not by listing
 * every run under the deployment.
 */
import { readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import { briefVerdictIn } from "@solutions-builder/app/document";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-thread";
import type { Stage } from "@solutions-builder/app/ledger";
import { createHubTransport } from "./hub.ts";

export type { StageTurn };

/** The `onTrigger` step id every person message for every stage arrives on. */
const CHAT_STEP_ID = "chat";
/** The chat body's own routing step: its output names the stage a message was for. */
const ROUTE_STEP_ID = "route";

type RunEvent = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

function eventBody(event: RunEvent): Record<string, unknown> {
  return event.body;
}

function findEvent(events: readonly RunEvent[], type: string, stepId?: string): RunEvent | undefined {
  return events.find((event) => event.type === type && (stepId === undefined || eventBody(event).stepId === stepId));
}

/**
 * Every chat occurrence's body run id, read off the anchor's own
 * `ChildSpawned` events for the `chat` section, oldest first (event index
 * order is spawn order).
 */
function chatOccurrenceRunIds(anchorEvents: readonly RunEvent[]): string[] {
  return anchorEvents
    .filter((event) => event.type === "ChildSpawned" && eventBody(event).stepId === CHAT_STEP_ID)
    .map((event) => String(eventBody(event).childRunId ?? ""))
    .filter((id) => id.length > 0);
}

/** Resolves a step output ref over the `/hub` passthrough, same rule as `run-fold.ts`'s blob reads. */
function readRefOver(tenantId: string, anchorRunId: string, transport: Transport): (occurrenceRunId: string, ref: string) => Promise<unknown> {
  return async (occurrenceRunId, ref) => {
    if (ref.startsWith("inline:")) return JSON.parse(ref.slice("inline:".length));
    const match = /^blob:(.+)$/.exec(ref);
    if (!match) throw new Error(`Unrecognized step output ref: ${ref}`);
    return transport.fetch(
      "GET",
      `/api/tenants/${tenantId}/workflows/${anchorRunId}/runs/${occurrenceRunId}/blobs/${match[1]}`,
    );
  };
}

async function resolveOutput<T>(
  occurrenceRunId: string,
  event: RunEvent | undefined,
  readRef: (occurrenceRunId: string, ref: string) => Promise<unknown>,
): Promise<T | null> {
  if (!event) return null;
  const output = eventBody(event).output as { ref?: unknown } | undefined;
  if (typeof output?.ref !== "string") return null;
  return (await readRef(occurrenceRunId, output.ref)) as T;
}

/** `routeMessage`'s step output: the ledger round command a person's mail carried, and the stage it was for. */
type RouteOutput = {
  readonly stage: Stage;
  readonly command: string;
  readonly message?: string;
  readonly quotes?: Quote[];
};

type ReplyOutput = { readonly reply: string };

/** The stage-N specialist reply step ids that always run, right after `route`, once a stage is routed to. */
function repliesFor(stage: Stage): string[] {
  if (stage === 1) return ["draft-1", "evaluate-1"];
  if (stage === 6) return ["requirements-6", "draft-6"];
  return [`draft-${stage}`];
}

/** Stage 5's per-audience packages and stage 6's per-specialty panel reviews: dynamic step ids, read straight off the occurrence's own completed steps. */
function fannedOutReplies(events: readonly RunEvent[], stage: Stage): string[] {
  const prefix = stage === 5 ? "package-5-" : stage === 6 ? "review-6-" : null;
  if (prefix === null) return [];
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== "StepCompleted") continue;
    const stepId = String(eventBody(event).stepId ?? "");
    if (stepId.startsWith(prefix)) ids.add(stepId);
  }
  return [...ids];
}

/** One occurrence's turns: the person's routed message, then each specialist reply that completed for its stage, in step-completion order. */
async function turnsFromOccurrence(
  runId: string,
  events: readonly RunEvent[],
  readRef: (occurrenceRunId: string, ref: string) => Promise<unknown>,
): Promise<{ stage: Stage; turns: StageTurn[] } | null> {
  const routeCompleted = findEvent(events, "StepCompleted", ROUTE_STEP_ID);
  const route = await resolveOutput<RouteOutput>(runId, routeCompleted, readRef);
  if (!route || !routeCompleted) return null;

  const turns: StageTurn[] = [
    {
      id: `${runId}:${ROUTE_STEP_ID}`,
      role: "human",
      body: route.message ?? "",
      quotes: route.quotes ?? [],
      resultNodeId: null,
      questions: null,
      createdAt: String(eventBody(routeCompleted).at),
    },
  ];

  const replySteps = [...repliesFor(route.stage), ...fannedOutReplies(events, route.stage)];
  for (const stepId of replySteps) {
    const completed = findEvent(events, "StepCompleted", stepId);
    if (!completed) continue;
    const reply = await resolveOutput<ReplyOutput>(runId, completed, readRef);
    if (typeof reply?.reply !== "string") continue;
    turns.push({
      id: `${runId}:${stepId}`,
      role: "specialist",
      body: reply.reply,
      quotes: [],
      resultNodeId: null,
      questions: null,
      createdAt: String(eventBody(completed).at),
    });
  }

  return { stage: route.stage, turns };
}

export type ThreadArgs = {
  readonly tenantId: string;
  /** Null when the lifecycle has not been placed yet: no occurrences to fold. */
  readonly anchorRunId: string | null;
  readonly stage: Stage;
  /** Carried for signature compatibility with the pages that call this; unused by the events-only fold. */
  readonly nodes?: readonly unknown[];
  /** `ProjectDetail.opening`, passed through only at stage 1 by the caller. */
  readonly opening: { readonly body: string; readonly createdAt: string } | null;
  /** `ProjectDetail.carriedTurns`, already filtered to this stage by the caller. */
  readonly carried: readonly StageTurn[];
  readonly transport?: Transport;
};

/** The stage thread: the chat section's own occurrences folded for this stage, with the opening statement and any carried-in turns stitched ahead of them. */
export async function foldStageThread(args: ThreadArgs): Promise<StageTurn[]> {
  const here: StageTurn[] = [];

  if (args.opening) {
    here.push({
      id: "opening",
      role: "human",
      body: args.opening.body,
      quotes: [],
      resultNodeId: null,
      questions: null,
      createdAt: args.opening.createdAt,
    });
  }

  if (args.anchorRunId !== null) {
    const transport = args.transport ?? createHubTransport();
    const { events: anchorEvents } = await readWorkflowRunEvents(transport, args.tenantId, args.anchorRunId, args.anchorRunId);
    const readRef = readRefOver(args.tenantId, args.anchorRunId, transport);
    for (const occurrenceRunId of chatOccurrenceRunIds(anchorEvents)) {
      const { events } = await readWorkflowRunEvents(transport, args.tenantId, args.anchorRunId, occurrenceRunId);
      const folded = await turnsFromOccurrence(occurrenceRunId, events, readRef);
      if (folded && folded.stage === args.stage) here.push(...folded.turns);
    }
  }

  if (args.carried.length === 0) return here;
  // What was carried in happened before anything that ran here; the opening
  // statement, when there is one, came before all of it.
  const [first, ...rest] = here;
  const before = first?.id === "opening" ? [first] : [];
  const after = first?.id === "opening" ? rest : here;
  return [...before, ...args.carried, ...after];
}

/**
 * The next open question over already-projected turns: the last specialist
 * turn that carried a list of questions starts a round, and every human turn
 * after it answers the next one. Pure over `StageTurn[]`, so it reads the same
 * regardless of what folded the turns.
 */
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

/** The latest brief-evaluator verdict for the stage, or null before one has run. */
export async function foldEvaluation(args: {
  readonly tenantId: string;
  readonly anchorRunId: string | null;
  readonly stage: Stage;
  readonly transport?: Transport;
}): Promise<{ ready: boolean; notes: string[] } | null> {
  if (args.anchorRunId === null) return null;
  const transport = args.transport ?? createHubTransport();
  const { events: anchorEvents } = await readWorkflowRunEvents(transport, args.tenantId, args.anchorRunId, args.anchorRunId);
  const readRef = readRefOver(args.tenantId, args.anchorRunId, transport);
  const occurrenceIds = chatOccurrenceRunIds(anchorEvents);
  for (let index = occurrenceIds.length - 1; index >= 0; index -= 1) {
    const runId = occurrenceIds[index]!;
    const { events } = await readWorkflowRunEvents(transport, args.tenantId, args.anchorRunId, runId);
    const completed = findEvent(events, "StepCompleted", "evaluate-1");
    if (!completed) continue;
    const reply = await resolveOutput<ReplyOutput>(runId, completed, readRef);
    return typeof reply?.reply === "string" ? briefVerdictIn(reply.reply) : null;
  }
  return null;
}
