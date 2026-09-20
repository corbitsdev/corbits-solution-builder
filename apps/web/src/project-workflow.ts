/**
 * The project workflow's client-side read: a pure fold of the run's own
 * event log into a view a page can render, with no lifecycle chat section
 * and no server-side projection of its own (CL-8721). The workflow's carried
 * `ProjectState` only ever surfaces through a loop-iteration child run's
 * `apply` step output (while the project is still open) or the top-level
 * run's own `rework` step output (once every stage is approved and the loop
 * has converged) -- see
 * `packages/solutions-builder/src/project-workflow/{workflow,contracts}.ts`
 * and `scripts/project-workflow-proof-deployed.ts`'s `finalStateFrom`/
 * `applyStepOutputFrom`, which read the identical shapes.
 */
import type { WorkflowRunEvent } from "@intx/hub-client";
import type { DecisionRecord, ProjectState, ReviewState, StageNumber } from "@solutions-builder/app/project-workflow/contracts";

const LOOP_STEP_ID = "rework";
const APPLY_STEP_ID = "apply";

export type ProjectWorkflowView = {
  readonly stage: StageNumber;
  readonly done: boolean;
  readonly openReview: ReviewState | null;
  readonly reviews: Readonly<Record<StageNumber, ReviewState | undefined>>;
  readonly decisions: readonly DecisionRecord[];
  readonly lastRefusal: DecisionRecord | null;
  readonly allowed: { readonly openReview: boolean; readonly approve: boolean; readonly sendBack: boolean };
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

/** The newest loop-iteration run id keyed into `iterationEventsByRunId`,
 *  identified by the numeric suffix every iteration child run id carries
 *  (`<runId>__rework__<n>`) -- the same convention
 *  `project-workflow-proof-deployed.ts`'s `iterationRunIds` sorts on. */
function newestIterationEvents(iterationEventsByRunId: Readonly<Record<string, readonly WorkflowRunEvent[]>>): readonly WorkflowRunEvent[] | undefined {
  const ids = Object.keys(iterationEventsByRunId);
  if (ids.length === 0) return undefined;
  const withIndex = ids
    .map((id) => ({ id, index: Number(id.slice(id.lastIndexOf("__") + 2)) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);
  const newest = withIndex.at(-1)?.id ?? ids[0];
  return iterationEventsByRunId[newest!];
}

/** The carried `ProjectState` off `topEvents`/`iterationEventsByRunId`: the
 *  top-level `rework` loop container's own committed output once the run has
 *  converged, otherwise the newest iteration's `apply` step output. */
function projectStateOf(
  topEvents: readonly WorkflowRunEvent[],
  iterationEventsByRunId: Readonly<Record<string, readonly WorkflowRunEvent[]>>,
): ProjectState {
  const loopOutput = outputOf(topEvents, LOOP_STEP_ID) as { final?: { apply?: ProjectState } } | undefined;
  if (loopOutput?.final?.apply) return loopOutput.final.apply;
  const newest = newestIterationEvents(iterationEventsByRunId);
  const applied = newest ? (outputOf(newest, APPLY_STEP_ID) as ProjectState | undefined) : undefined;
  return applied ?? EMPTY_STATE;
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
  const state = projectStateOf(topEvents, iterationEventsByRunId);
  const openReview = state.reviews[state.stage]?.status === "open" ? state.reviews[state.stage]! : null;
  const lastRefusal = [...state.decisions].reverse().find((d) => !d.accepted) ?? null;
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
    },
  };
}
