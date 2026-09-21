/**
 * The Product guide — client-side restoration of BUILD_PLAN_V3 section 8.
 *
 * Calm orientation across the nine stages: where the project stands, what is
 * missing, and one recommended next step. It never writes an artifact, never
 * dispatches, and never records a decision — the approve gate reads only
 * `workflowView.allowed.approve`, never anything from here.
 *
 * The checklist below is the floor: computed purely from what the client
 * already reads (the project workflow view and the project's artifact
 * nodes), so it is always available with no model at all. The agent's own
 * words are enrichment on top of it, read back through its own stage mail
 * thread the same way a stage specialist's conversation is — but its own
 * distinct deployment (`api.ensureGuideAgent`, `agentById("product-guide")`
 * under its own roleKey), never the stage's own specialist.
 */
import { nextStep, type NextStep } from "@solutions-builder/app/next-step";
import type { ArtifactNode } from "../../client.js";
import type { ProjectWorkflowView } from "../../project-workflow.js";

export type Guidance = {
  readonly summary: string;
  readonly missing: readonly string[];
  readonly recommended: string;
  /** Which of the two a person is reading — always shown alongside this. */
  readonly origin: "checklist" | "guide";
};

const HEADING_SUMMARY = "where this stands";
const HEADING_MISSING = "what is missing";
const HEADING_RECOMMENDED = "recommended next step";

/** The deterministic floor: always available, never wrong, never clever. */
export function deterministicGuidance(
  view: ProjectWorkflowView | null,
  stage: number,
  nodes: readonly ArtifactNode[],
): Guidance {
  const hasDraft = nodes.some((node) => node.stage === stage);
  const state = view === null ? null : view.done ? "delivered" : view.openReview !== null ? "waiting_approval" : "in_progress";
  const step: NextStep = nextStep({ state, stage, hasDraft });

  const missing: string[] = [];
  if (!hasDraft) missing.push("This stage has no version yet.");
  const reviews: Readonly<Record<number, unknown>> = view?.reviews ?? {};
  if (view && !view.done && reviews[stage] === undefined) {
    missing.push("No decision has been recorded for this stage yet.");
  }

  return {
    summary: `Stage ${stage} of 9. ${step.detail}`,
    missing,
    recommended: step.title,
    origin: "checklist",
  };
}

/** The prompt mailed to the guide's own deployment when a person asks for guidance. */
export function guidancePrompt(view: ProjectWorkflowView | null, stage: number, projectTitle: string): string {
  return [
    `A person working on "${projectTitle}" (stage ${stage} of 9) has asked to be oriented, not for stage work.`,
    view?.done ? "The project is delivered." : "",
    "Orient them. Be brief, and recommend one next step without taking it.",
    "",
    "Produce exactly these headings:",
    "## Where this stands",
    "## What is missing",
    "## Recommended next step",
  ]
    .filter(Boolean)
    .join("\n");
}

function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^#{1,4}\s+(.*)$/.exec(line);
    if (match) {
      if (heading) sections.set(heading.toLowerCase(), body.join("\n").trim());
      heading = match[1]!.trim();
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  if (heading) sections.set(heading.toLowerCase(), body.join("\n").trim());
  return sections;
}

const bullets = (block: string): string[] =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^_?none\b/i.test(line))
    .slice(0, 8);

/** Parses a specialist reply into guidance, or null when it does not look
 * like one — the caller falls back to the checklist either way. */
export function parseGuidanceReply(text: string, floor: Guidance): Guidance | null {
  const sections = sectionsOf(text);
  const summary = sections.get(HEADING_SUMMARY)?.trim();
  if (!summary) return null;

  const missing = bullets(sections.get(HEADING_MISSING) ?? "");
  const recommended = (sections.get(HEADING_RECOMMENDED) ?? "")
    .split("\n")[0]
    ?.replace(/^\s*[-*+]\s+/, "")
    .trim();

  return {
    summary: summary.slice(0, 1200),
    missing,
    recommended: (recommended || floor.recommended).slice(0, 120),
    origin: "guide",
  };
}
