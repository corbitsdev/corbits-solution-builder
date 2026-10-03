/**
 * The project workflow's client-side read: a pure fold of the run's own
 * event log into a view a page can render, with no lifecycle chat section
 * and no server-side projection of its own (CL-8721). The workflow's carried
 * `ProjectState` only ever surfaces through a loop-iteration child run's
 * `apply` step output (while the project is still open) or the top-level
 * run's own `rework` step output (once every stage is approved and the loop
 * has converged) -- see
 * `packages/solutions-builder/src/project-workflow/{workflow,contracts}.ts`.
 */
import type { Transport, WorkflowRunEvent } from "@intx/hub-client";
import { workflowsFor, type ProjectWorkflowDeployment } from "@solutions-builder/installer";
import {
  approveReason,
  CHOICES,
  missingChoice,
  quorumState,
  type ApproveReason,
  type AudiencePackageRef,
  type AudiencePolicy,
  type AudienceVote,
  type DecisionRecord,
  type Freeze,
  type ProjectState,
  type QuorumState,
  type ReviewState,
  type StageNumber,
  type Surface,
} from "@solutions-builder/app/project-workflow/contracts";
import type { RequirementEntry } from "@solutions-builder/app/stack";

const LOOP_STEP_ID = "rework";
const APPLY_STEP_ID = "apply";
const HOLD_STEP_ID = "hold";
const NAME_STEP_ID = "name";

export type ProjectWorkflowView = {
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly openReview: ReviewState | null;
  readonly reviews: Readonly<Record<StageNumber, ReviewState | undefined>>;
  readonly decisions: readonly DecisionRecord[];
  readonly lastRefusal: DecisionRecord | null;
  readonly allowed: {
    readonly openReview: boolean;
    readonly approve: boolean;
    readonly sendBack: boolean;
    /** Why `approve` is false, or null once it is true -- the workflow's own
     *  verdict (`project-workflow/contracts.ts`'s `approveReason`), never
     *  re-derived from chat or artifacts. */
    readonly approveReason: ApproveReason | null;
  };
  /** Stage 7's freeze, once approved; null before then or after a send-back
   *  to stage <= 7 clears it. */
  readonly freeze: Freeze | null;
  /** Requirement ids `mint_requirements` minted, once, before the Architect
   *  runs; empty until then, cleared by a send-back to stage <= 6. */
  readonly requirements: readonly RequirementEntry[];
  /** Stage 5's quorum policy, captured by the `open_review` that opened the
   *  current (or most recent) stage-5 review; null before one has. */
  readonly audiencePolicy: AudiencePolicy | null;
  /** Every stakeholder's latest `audience` vote, keyed by audience name --
   *  `pages/audiences.tsx`'s tally reads this, never artifact metadata. */
  readonly audienceDecisions: Readonly<Record<string, AudienceVote>>;
  /** Each stakeholder's current package as the stage-5 `open_review` named
   *  them -- what a vote is checked against before it counts (#50). */
  readonly audiencePackages: Readonly<Record<string, AudiencePackageRef>>;
  /** `audiencePolicy`/`audienceDecisions`/`audiencePackages` folded through
   *  `quorumState`; null until `audiencePolicy` is captured. */
  readonly stage5Quorum: QuorumState | null;
  /** What is being built, as stage 3's approval named it; null before then. */
  readonly surface: Surface | null;
  /** Stages that surface makes not applicable. */
  readonly skipped: readonly StageNumber[];
  /** Each stage's recorded `choice` answers. */
  readonly choices: ProjectState["choices"];
  /** The question of the first choice the current stage still requires
   *  (`missingChoice`); null once every one is answered. */
  readonly waitingOn: string | null;
  /** The `name` step's reply, once it has completed with one; null before
   *  then, and for good when it failed. */
  readonly generatedTitle: string | null;
};

const EMPTY_STATE: ProjectState = {
  projectId: "",
  stage: 0,
  done: false,
  reviews: {},
  decisions: [],
  authorizedPrincipals: {},
  stageOrder: [],
  reviewCounts: {},
  freeze: null,
  requirements: [],
  audiencePolicy: null,
  audienceDecisions: {},
  audiencePackages: {},
  surface: null,
  skipped: [],
  choices: {},
};

function decodeInlineOutput(ref: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("inline:")) return undefined;
  try {
    return JSON.parse(ref.slice("inline:".length));
  } catch {
    return undefined;
  }
}

function outputOf(events: readonly WorkflowRunEvent[], stepId: string): unknown {
  const completed = [...events].reverse().find((e) => e.type === "StepCompleted" && e.body["stepId"] === stepId);
  const output = completed?.body["output"] as { ref?: unknown } | undefined;
  return decodeInlineOutput(output?.ref);
}

/** Every loop-iteration run id keyed into `iterationEventsByRunId`, oldest
 *  first, ordered by the numeric suffix every iteration child run id carries
 *  (`<runId>__rework__<n>`). */
function orderedIterationIds(iterationEventsByRunId: Readonly<Record<string, readonly WorkflowRunEvent[]>>): readonly string[] {
  const ids = Object.keys(iterationEventsByRunId);
  return ids
    .map((id) => ({ id, index: Number(id.slice(id.lastIndexOf("__") + 2)) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.id);
}

/**
 * Whether the newest iteration's own event log carries a committed `hold`
 * step output yet -- the signal `api.projectWorkflowView` uses to decide
 * whether it needs to also fetch the previous iteration's events (a rare
 * race: the newest iteration run exists but its `hold` step has not
 * committed on the hub yet).
 */
export function newestIterationHasHoldOutput(events: readonly WorkflowRunEvent[] | undefined): boolean {
  return events !== undefined && outputOf(events, HOLD_STEP_ID) !== undefined;
}

/** The carried `ProjectState` off `topEvents`/`iterationEventsByRunId`: the
 *  top-level `rework` loop container's own committed output once the run has
 *  converged; otherwise the newest iteration's `apply` output once a
 *  decision has landed this iteration, else its `hold` output (the state
 *  carried into this iteration, unchanged so far); when the newest iteration
 *  has neither yet, the previous iteration's `apply` output (present in
 *  `iterationEventsByRunId` only for that rare race). */
function projectStateOf(
  topEvents: readonly WorkflowRunEvent[],
  iterationEventsByRunId: Readonly<Record<string, readonly WorkflowRunEvent[]>>,
): ProjectState {
  const loopOutput = outputOf(topEvents, LOOP_STEP_ID) as { final?: { apply?: ProjectState } } | undefined;
  if (loopOutput?.final?.apply) return loopOutput.final.apply;

  const ids = orderedIterationIds(iterationEventsByRunId);
  const newestEvents = ids.at(-1) ? iterationEventsByRunId[ids.at(-1)!] : undefined;
  const applied = newestEvents ? (outputOf(newestEvents, APPLY_STEP_ID) as ProjectState | undefined) : undefined;
  if (applied) return applied;
  const held = newestEvents ? (outputOf(newestEvents, HOLD_STEP_ID) as ProjectState | undefined) : undefined;
  if (held) return held;

  const previousEvents = ids.length >= 2 ? iterationEventsByRunId[ids.at(-2)!] : undefined;
  const previousApplied = previousEvents ? (outputOf(previousEvents, APPLY_STEP_ID) as ProjectState | undefined) : undefined;
  return previousApplied ?? EMPTY_STATE;
}

/**
 * Pure fold from recorded run events to a view. `topEvents` is the top-level
 * run's own event log; `iterationEventsByRunId` is every loop-iteration
 * child run's event log, keyed by its run id -- both read the same way
 * `api.projectWorkflowView` reads them off the hub.
 */
export function foldProjectWorkflow(
  topEvents: readonly WorkflowRunEvent[],
  iterationEventsByRunId: Readonly<Record<string, readonly WorkflowRunEvent[]>>,
): ProjectWorkflowView {
  return projectWorkflowViewOf(projectStateOf(topEvents, iterationEventsByRunId), generatedTitleOf(topEvents));
}

/** The `name` step's trimmed `reply` (an agent step's output is `{ reply, turn }`). */
function generatedTitleOf(topEvents: readonly WorkflowRunEvent[]): string | null {
  const output = outputOf(topEvents, NAME_STEP_ID) as { reply?: unknown } | undefined;
  const reply = typeof output?.reply === "string" ? output.reply.trim() : "";
  return reply.length > 0 ? reply : null;
}

/** The view one carried `ProjectState` renders as; `foldProjectWorkflow` over the state it finds in the events. */
export function projectWorkflowViewOf(state: ProjectState, generatedTitle: string | null = null): ProjectWorkflowView {
  const openReview = state.reviews[state.stage]?.status === "open" ? state.reviews[state.stage]! : null;
  const lastRefusal = [...state.decisions].reverse().find((d) => !d.accepted) ?? null;
  // A run deployed before stage-5 reviews named each stakeholder's package
  // carries no map at all; read as empty, every vote it holds is stale
  // rather than the fold failing (#50).
  const audiencePackages: Readonly<Record<string, AudiencePackageRef>> = state.audiencePackages ?? {};
  const missing = missingChoice(state);
  return {
    stage: state.stage,
    done: state.done,
    openReview,
    reviews: state.reviews,
    decisions: state.decisions,
    lastRefusal,
    allowed: {
      openReview: !state.done,
      approve: !state.done && openReview !== null,
      sendBack: !state.done,
      approveReason: approveReason(state),
    },
    freeze: state.freeze,
    requirements: state.requirements,
    audiencePolicy: state.audiencePolicy,
    audienceDecisions: state.audienceDecisions,
    audiencePackages,
    stage5Quorum: state.audiencePolicy ? quorumState(state.audiencePolicy, state.audienceDecisions, audiencePackages) : null,
    // A run deployed before surfaces and choices were recorded carries none of these.
    surface: state.surface ?? null,
    skipped: state.skipped ?? [],
    choices: state.choices ?? {},
    waitingOn: missing ? CHOICES[missing].question : null,
    generatedTitle,
  };
}

/**
 * Reads `ref`'s current view off the hub: the top-level run's own events
 * plus ONLY the newest loop-iteration run (see the module doc comment on the
 * one race that also needs the previous iteration), then folds them with
 * `foldProjectWorkflow`. Shared by `client.ts`'s `api.projectWorkflowView`
 * and `project-view.ts`'s `loadProjectView`, which both need this exact
 * read -- one over an already-triggered ref, the other over a ref resolved
 * read-only by `findProjectWorkflow`.
 */
export async function loadProjectWorkflowView(transport: Transport, ref: ProjectWorkflowDeployment): Promise<ProjectWorkflowView> {
  // The ref names the tenant its run lives in: the project's own, or the
  // workspace for a workflow deployed before #29 (`ProjectWorkflowDeployment`).
  const workflows = workflowsFor(transport, ref.tenantId);
  const [topEvents, runIds] = await Promise.all([
    workflows.runEvents(ref.deploymentId, ref.runId),
    workflows.runs(ref.deploymentId),
  ]);
  const iterationIds = runIds
    .filter((id) => id.startsWith(`${ref.runId}__`))
    .map((id) => ({ id, index: Number(id.slice(id.lastIndexOf("__") + 2)) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.id);

  const iterationEventsByRunId: Record<string, WorkflowRunEvent[]> = {};
  const newestId = iterationIds.at(-1);
  if (newestId) {
    iterationEventsByRunId[newestId] = (await workflows.runEvents(ref.deploymentId, newestId)).events;
    const previousId = iterationIds.length >= 2 ? iterationIds.at(-2) : undefined;
    if (previousId && !newestIterationHasHoldOutput(iterationEventsByRunId[newestId])) {
      iterationEventsByRunId[previousId] = (await workflows.runEvents(ref.deploymentId, previousId)).events;
    }
  }
  return foldProjectWorkflow(topEvents.events, iterationEventsByRunId);
}
