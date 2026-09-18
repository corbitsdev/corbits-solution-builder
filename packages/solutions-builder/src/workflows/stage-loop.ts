/**
 * The chat section and approve chain — BUILD_PLAN_V3 §9's `stage`, as a
 * mail-driven `onTrigger` body plus a plain chain of top-level gates.
 *
 * Loops are gone (INTR-400/402/541: a loop-body signal relay never fires).
 * Every person input, for every stage, is conversation mail to the run's
 * `chat` section; `route` reads it and a binary `is-N` gate chain dispatches
 * to that stage's agent steps (rendered only once an offering exists — see
 * `lifecycle-source.ts`) or to `none` when there is nothing to run. Approval
 * is a separate, parallel concern: a flat chain of top-level `awaitSignal`
 * gates a client signals directly, unchanged in name from the loop-based
 * design so grants and the web app keep working against them.
 */
import { action, awaitSignal, defineWorkflow, escalation, gate, type WorkflowDefinition } from "@intx/workflow";
import type { Stage } from "../ledger.js";
import { panelPrincipals } from "../kit.js";

export const STAGE_WORKFLOW_ID = "solutions-builder.stage";

/**
 * How long one drafting agent step may run before the runtime fails it.
 * Matches `DEFAULT_TIMEOUT_MS` in `apps/hub/src/inference.ts`, the timeout
 * the host itself uses for an inference call of this shape.
 */
export const DRAFT_STEP_TIMEOUT_MS = 15 * 60 * 1000;
/** How long one build attempt may run before the runtime fails the step. */
export const BUILD_STEP_TIMEOUT_MS = 30 * 60 * 1000;

/** The stage whose rounds run the build agent; a run is never driven through it. */
const BUILD_STAGE: Stage = 8;
/** The stage after which the run freezes into stage 8: cost is approved at 7. */
const FREEZE_STAGE: Stage = 7;
/** The stage whose delivery is a stock hub approval on the specialist's own tool call. */
export const DELIVERY_STAGE: Stage = 9;

// --- The chat section's body ------------------------------------------------

/** The top-level `onTrigger` section's own step id, on the anchor run. */
export const CHAT_STEP_ID = "chat";
/** The chat body's routing action: parses the mail, decides the stage. */
export const ROUTE_STEP_ID = "route";
/** The chat body's binary router gate for a given stage. */
export function routerStepId(stage: Stage): string {
  return `is-${stage}`;
}
/** The router's dead end: nothing this stage's agent steps need to run. */
export const NONE_STEP_ID = "none";
/**
 * `is-8`'s else branch: nothing at all was routed. A distinct terminal from
 * `NONE_STEP_ID` — the deploy validator rejects a gate whose `then` and
 * `else` are the same step, which the gates-only definition would otherwise
 * hit at `is-8` (`then` falls back to `none` too, with no agent steps).
 */
export const UNROUTED_STEP_ID = "unrouted";
/** Stage 9's delivery check, a top-level step outside the chat body. */
export const DELIVERY_STEP_ID = "delivery-check";

/** Stage 6's requirements-authoring step, ahead of its draft. */
export const REQUIREMENTS_STEP_ID = "requirements-6";
/** The advisory brief-evaluator step, stage 1 only. */
export const EVALUATE_STEP_ID = "evaluate-1";
/** The build stage's one agent step. */
export const BUILD_STEP_ID = "build-8";

/** A stage's own drafting step id. */
export function draftStepId(stage: Stage): string {
  return `draft-${stage}`;
}
/** One of stage 5's per-audience packaging steps, by fan-out index. */
export function packageStepId(index: number): string {
  return `package-5-${index}`;
}
/** One of stage 6's panel principals reviewing the draft. */
export function reviewStepId(specialty: string): string {
  return `review-6-${specialty}`;
}

/** A panel principal's short specialty id, read off its seeded role id. */
function panelSpecialty(roleId: string): string {
  const specialty = roleId.replace(/^senior-engineer-/, "");
  if (specialty === roleId) throw new Error(`Not a panel principal role: ${roleId}`);
  return specialty;
}

/**
 * The agent step ids a stage's chat-body branch contributes, in run order.
 * Stage 9 contributes none here: its delivery check is a top-level step
 * outside the chat body (see `DELIVERY_STEP_ID`), never routed by `is-N`. A
 * stage 5 with no audiences contributes none either: nothing to package.
 */
export function agentStepIds(stage: Stage, audienceCount: number): string[] {
  if (stage === 9) return [];
  if (stage === 5) {
    return Array.from({ length: audienceCount }, (_unused, index) => packageStepId(index));
  }
  if (stage === 6) {
    return [
      REQUIREMENTS_STEP_ID,
      draftStepId(6 as Stage),
      ...panelPrincipals().map((role) => reviewStepId(panelSpecialty(role.id))),
    ];
  }
  if (stage === 1) {
    return [draftStepId(1 as Stage), EVALUATE_STEP_ID];
  }
  if (stage === BUILD_STAGE) {
    return [BUILD_STEP_ID];
  }
  return [draftStepId(stage)];
}

const CHAT_STAGES: readonly Stage[] = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * The chat section's body: `route` reads the mail, then a binary `is-N` gate
 * chain dispatches to the first agent step of the stage the route named, or
 * falls through to `is-(N+1)`; `is-8`'s empty branch, and every stage with no
 * agent steps at all, lands on `none`.
 *
 * `agentStepsByStage` supplies each stage's already-wired step records
 * (rendered only once an offering exists — see `lifecycle-source.ts`), keyed
 * by stage, in the order they must run; the first key is what `is-N` jumps
 * to. Omitted (the in-process, gates-only definition), every `is-N` lands on
 * `none` directly: there is no agent to hand the mail to yet.
 */
export function chatBody(agentStepsByStage?: Partial<Record<Stage, Record<string, unknown>>>): WorkflowDefinition {
  const steps: Record<string, unknown> = {
    [ROUTE_STEP_ID]: action({
      handler: "routeMessage",
      input: { from: "trigger.payload" },
    }),
  };

  for (const stage of CHAT_STAGES) {
    const isId = routerStepId(stage);
    const stageSteps = agentStepsByStage?.[stage];
    const firstStepId = stageSteps ? Object.keys(stageSteps)[0] : undefined;
    const nextElse = stage === 8 ? UNROUTED_STEP_ID : routerStepId((stage + 1) as Stage);
    steps[isId] = gate({
      when: { from: `steps.${ROUTE_STEP_ID}.output.at.${stage}` },
      then: firstStepId ?? NONE_STEP_ID,
      else: nextElse,
      after: [stage === 1 ? ROUTE_STEP_ID : routerStepId((stage - 1) as Stage)],
    });
    if (stageSteps) Object.assign(steps, stageSteps);
  }

  steps[NONE_STEP_ID] = escalation({ to: NONE_STEP_ID, after: [routerStepId(8 as Stage)] });
  steps[UNROUTED_STEP_ID] = escalation({ to: UNROUTED_STEP_ID, after: [routerStepId(8 as Stage)] });

  return defineWorkflow({
    id: `${STAGE_WORKFLOW_ID}.chat`,
    triggers: [{ type: "manual" }],
    steps: steps as never,
  });
}

// --- Approval: a flat chain of top-level signal gates -----------------------

/** The signal a stage's approval gate consumes. Unchanged in name from the loop design: grants and the web app depend on it. */
export function approveSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.approve`;
}

/** The signal `build.freeze` arrives on: stage 7 approved, the run freezes into stage 8. */
export function freezeSignal(): string {
  return `${STAGE_WORKFLOW_ID}.${FREEZE_STAGE}.freeze`;
}

/** The signal the evidence hand-off after the build agent consumes. */
export function evidenceSignal(stage: Stage): string {
  return `${STAGE_WORKFLOW_ID}.${stage}.evidence`;
}

/** The top-level step id for a stage's approval gate. */
export function gateStepId(stage: Stage): string {
  return `gate-${stage}`;
}

/** The top-level freeze park between stage 7's gate and stage 8's evidence hand-off. */
export const FREEZE_STEP_ID = "freeze";
/** The top-level evidence park between the freeze and stage 8's gate. */
export const EVIDENCE_STEP_ID = "evidence";

/**
 * The approve chain: `gate-1` … `gate-8`, all top-level, all
 * `drainBehavior:"wait"`. `gate-7` is followed by `freeze`, then `evidence`,
 * then `gate-8` — the one place the flat N-follows-(N-1) chain bends, because
 * a stage-7 approval only frees the run to be frozen into a build, and the
 * build's own evidence hand-off has to resolve before stage 8 can be
 * approved.
 */
export function approveChain(): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const stage of [1, 2, 3, 4, 5, 6, 7] as Stage[]) {
    steps[gateStepId(stage)] = awaitSignal({
      name: approveSignal(stage),
      drainBehavior: "wait",
      ...(stage > 1 ? { after: [gateStepId((stage - 1) as Stage)] } : {}),
    });
  }
  steps[FREEZE_STEP_ID] = awaitSignal({
    name: freezeSignal(),
    drainBehavior: "wait",
    after: [gateStepId(7 as Stage)],
  });
  steps[EVIDENCE_STEP_ID] = awaitSignal({
    name: evidenceSignal(BUILD_STAGE),
    drainBehavior: "wait",
    after: [FREEZE_STEP_ID],
  });
  steps[gateStepId(BUILD_STAGE)] = awaitSignal({
    name: approveSignal(BUILD_STAGE),
    drainBehavior: "wait",
    after: [EVIDENCE_STEP_ID],
  });
  return steps;
}

// --- Following a run's position ---------------------------------------------

/** The stage a signal name this module issued belongs to, or null for any other name. */
export function stageOfSignal(signalName: string): Stage | null {
  const match = new RegExp(`^${STAGE_WORKFLOW_ID.replace(/\./g, "\\.")}\\.([1-9])\\.`).exec(signalName);
  return match ? (Number(match[1]) as Stage) : null;
}

/** The stage a top-level step belongs to, or null for a step that is not one of these. */
export function stageOfStepId(stepId: string): Stage | null {
  if (stepId === FREEZE_STEP_ID) return FREEZE_STAGE;
  if (stepId === EVIDENCE_STEP_ID) return BUILD_STAGE;
  if (stepId === DELIVERY_STEP_ID) return DELIVERY_STAGE;
  const match = /^gate-(\d)$/.exec(stepId);
  return match ? (Number(match[1]) as Stage) : null;
}

/**
 * The top-level step ids a stage ends on. Every stage but 7 ends at its own
 * approval gate; stage 7 ends at the freeze that follows its gate, since
 * that is what actually hands the run into stage 8.
 */
export function stageEnds(stage: Stage): string[] {
  if (stage === FREEZE_STAGE) return [FREEZE_STEP_ID];
  return [gateStepId(stage)];
}
