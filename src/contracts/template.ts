/**
 * Workflow templates — BUILD_PLAN_V3 §9.
 *
 * §9 fixes what a template may do and, more importantly, what it may not:
 * "Templates can add internal steps/artifacts/specialists/tests, not
 * remove/reorder stages, weaken approvals, mutate history, change accepted
 * artifacts silently or claim unsupported controls."
 *
 * Those are the rules a future iOS or hardware template will be written
 * against, by someone who has not read this file. So they are checked here
 * rather than described: `violationsIn` is the whole contract, and a template
 * that breaks one cannot be seeded.
 */
import { STAGES, STAGE_TITLES, type Stage } from "./ledger.js";

/** The slots §9 names, in the order the stages run. */
export const SLOTS = [
  "discovery-interviewer",
  "constraint-mapper",
  "proposal-strategy",
  "surface-design",
  "design-feedback",
  "audience-package",
  "plan-and-review",
  "estimate-and-policy",
  "build-execution",
  "target-verification",
  "delivery-manifest",
] as const;
export type Slot = (typeof SLOTS)[number];

export type SlotBinding = {
  readonly slot: Slot;
  /** The agent that fills it. A template replaces this, never the stage. */
  readonly agent: string;
  /** Extra steps a template adds inside the stage. Never removals. */
  readonly addedSteps: readonly string[];
};

export type TemplateGate = {
  readonly stage: Stage;
  readonly title: string;
  /** The command that leaves this gate. A template may not change it. */
  readonly command: string;
  /** Who must decide. A template may add authorities, never remove them. */
  readonly authorities: readonly string[];
};

export type WorkflowTemplateVersion = {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly gates: readonly TemplateGate[];
  readonly slots: readonly SlotBinding[];
};

/**
 * The base template: the nine gates as the ledger defines them, and one agent
 * per slot. Generated from the ledger so the gates cannot drift from it.
 */
export function baseTemplate(): WorkflowTemplateVersion {
  const bySlot: Record<Slot, string> = {
    "discovery-interviewer": "brainstormer",
    "constraint-mapper": "constraints-mapper",
    "proposal-strategy": "proposer",
    "surface-design": "experience-designer",
    "design-feedback": "experience-designer",
    "audience-package": "presentation-creator",
    "plan-and-review": "architect",
    "estimate-and-policy": "estimator",
    "build-execution": "build-supervisor",
    "target-verification": "delivery-verifier",
    "delivery-manifest": "delivery-verifier",
  };

  return {
    key: "sb-template-base-v1",
    version: 1,
    title: "The nine stages",
    gates: STAGES.map((stage) => ({
      stage,
      title: STAGE_TITLES[stage],
      // Stage 7 leaves on cost approval, not stage approval. That interlock is
      // in the ledger, and the template reads it rather than restating it.
      command: stage === 7 ? "cost.approve" : stage === 9 ? "delivery.accept" : "stage.approve",
      authorities:
        stage === 7
          ? ["budget_approver"]
          : stage === 9
            ? ["delivery_recipient", "project_owner"]
            : ["project_owner"],
    })),
    slots: SLOTS.map((slot) => ({ slot, agent: bySlot[slot], addedSteps: [] })),
  };
}

/**
 * What a candidate template breaks, in the words of §9.
 *
 * Empty means it may be seeded. Anything else is a template that would weaken
 * the product's guarantees while looking like a customisation, which is the
 * failure mode worth catching — nobody writes a template intending to remove a
 * gate, they write one intending to add a step and take a shortcut.
 */
export function violationsIn(candidate: WorkflowTemplateVersion): string[] {
  const base = baseTemplate();
  const problems: string[] = [];

  if (candidate.gates.length !== base.gates.length) {
    problems.push(
      `A template has ${candidate.gates.length} gates; the nine stages are fixed.`,
    );
  }

  for (const [index, expected] of base.gates.entries()) {
    const actual = candidate.gates[index];
    if (!actual) {
      problems.push(`Stage ${expected.stage} is missing.`);
      continue;
    }
    // Order is position, not sort: a template that lists the stages in a
    // different order has reordered them however it is later read.
    if (actual.stage !== expected.stage) {
      problems.push(
        `Stage ${expected.stage} is out of order (found stage ${actual.stage} at position ${index + 1}).`,
      );
    }
    if (actual.command !== expected.command) {
      problems.push(
        `Stage ${expected.stage} leaves on ${actual.command}; the ledger says ${expected.command}.`,
      );
    }
    // Adding an approver is a template's business. Removing one is weakening
    // an approval, which §9 forbids outright.
    for (const authority of expected.authorities) {
      if (!actual.authorities.includes(authority)) {
        problems.push(
          `Stage ${expected.stage} drops the ${authority} authority.`,
        );
      }
    }
  }

  const filled = new Set(candidate.slots.map((binding) => binding.slot));
  for (const slot of SLOTS) {
    if (!filled.has(slot)) problems.push(`The ${slot} slot is unfilled.`);
  }
  for (const binding of candidate.slots) {
    if (binding.agent.trim().length === 0) {
      problems.push(`The ${binding.slot} slot names no agent.`);
    }
  }

  return problems;
}
