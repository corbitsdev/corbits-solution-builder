/**
 * The Product guide — BUILD_PLAN_V3 section 8.
 *
 * Calm orientation across all nine stages: where the project stands, what
 * evidence is missing, what the human could do, and which of those is
 * recommended. Section 8's deterministic checklist is the whole of it here —
 * the agent enrichment it describes is CL-8342's filed follow-up (host
 * inference is being deleted; a guidance agent step belongs in the workflow,
 * not this file), tracked as a Linear issue under CL-8072.
 */
import { GuidanceRecord } from "./domain.js";
import { nextStep } from "@solutions-builder/app/next-step";
import type { RunState } from "@solutions-builder/app/ledger";

export type GuidanceInput = {
  /** Whose spend the call is; guidance for a project names it. */
  projectId?: string;
  projectTitle: string;
  stage: number;
  state: RunState | null;
  /** Live versions on this branch, oldest stage first. */
  versions: { id: string; title: string; stage: number; content: string }[];
  approvals: { stage: number; command: string; decision: string }[];
  quorum?: { recorded: number; needed: number; blocked: number };
};

/** The deterministic floor. Always available, never wrong, never clever. */
export function deterministicGuidance(input: GuidanceInput): GuidanceRecord {
  const step = nextStep({
    state: input.state,
    stage: input.stage,
    hasDraft: input.versions.some((version) => version.stage === input.stage),
    ...(input.quorum ? { quorum: input.quorum } : {}),
  });

  const missing: string[] = [];
  if (!input.versions.some((version) => version.stage === input.stage)) {
    missing.push("This stage has no version yet.");
  }
  if (!input.approvals.some((approval) => approval.stage === input.stage)) {
    missing.push("No human decision has been recorded for this stage.");
  }

  return {
    summary: `${input.projectTitle} is at stage ${input.stage}. ${step.detail}`,
    readiness: missing.length === 0 ? "ready" : "not_ready",
    missing,
    options: [{ label: step.title, detail: step.detail }],
    recommended: step.title,
    questions: [],
    sourceVersionIds: input.versions.map((version) => version.id),
    origin: "deterministic",
  };
}

/**
 * Guidance for a project.
 *
 * Never throws and never returns nothing: "what do I do now" is a question
 * this product must answer regardless of provider reachability, so this is
 * the deterministic checklist and nothing else for now.
 */
export async function runGuidance(input: GuidanceInput): Promise<GuidanceRecord> {
  return deterministicGuidance(input);
}
