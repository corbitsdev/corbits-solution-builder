/**
 * The Product guide — BUILD_PLAN_V3 section 8.
 *
 * Calm orientation across all nine stages: where the project stands, what
 * evidence is missing, what the human could do, and which of those is
 * recommended. It reads and it speaks. It has no artifact-write path, no
 * dispatch and no decision, which is why it is a separate agent rather than a
 * paragraph inside each specialist's prompt — a guide that could also write
 * would hold authority the plan denies it.
 *
 * Section 8 also fixes the failure behaviour: retry a transient inference
 * failure once, then fall back to a deterministic status checklist. So the
 * checklist is the floor and the agent is the enrichment, never the other way
 * round. A person is always told which of the two they are reading.
 */
import { type } from "arktype";
import { GuidanceRecord } from "./domain.js";
import { agentById } from "@solutions-builder/app/kit";
import { complete } from "./inference.js";
import { nextStep } from "@solutions-builder/app/next-step";
import type { RunState } from "@solutions-builder/app/ledger";

export type GuidanceInput = {
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

/** Section-headed prose is what the seeded guide prompt asks for. */
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

/**
 * Guidance for a project.
 *
 * Never throws and never returns nothing: a provider failure produces the
 * deterministic checklist, because "what do I do now" is a question this
 * product must answer even when no model will answer it.
 */
export async function runGuidance(input: GuidanceInput): Promise<GuidanceRecord> {
  const floor = deterministicGuidance(input);
  const guide = agentById("product-guide");
  if (!guide) return floor;

  const prompt = [
    `Project: ${input.projectTitle}`,
    `Current stage: ${input.stage}. Run state: ${input.state ?? "not started"}.`,
    "",
    input.versions.length === 0
      ? "No versions have been produced yet."
      : input.versions
          .map(
            (version) =>
              `--- VERSION ${version.id} — ${version.title} (stage ${version.stage}) ---\n${version.content.slice(0, 4000)}`,
          )
          .join("\n\n"),
    "",
    input.approvals.length === 0
      ? "No decisions have been recorded."
      : `Recorded decisions: ${input.approvals
          .map((approval) => `stage ${approval.stage} ${approval.command} → ${approval.decision}`)
          .join("; ")}`,
    "",
    "Orient the person. Be brief, and recommend one next step without taking it.",
  ].join("\n");

  // Section 8: one retry on a transient failure, then the checklist.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await complete({
        system: guide.system,
        prompt,
        temperature: guide.temperature,
        maxTokens: 1200,
      });
      const parsed = parseGuidance(result.text, input, floor);
      if (parsed) return parsed;
    } catch {
      // Fall through to the retry, then to the floor.
    }
  }
  return floor;
}

function parseGuidance(
  text: string,
  input: GuidanceInput,
  floor: GuidanceRecord,
): GuidanceRecord | null {
  const sections = sectionsOf(text);
  const summary = sections.get("where this stands")?.trim();
  if (!summary) return null;

  const missing = bullets(sections.get("what is missing") ?? "");
  const options = bullets(sections.get("your options") ?? "").map((line) => {
    const [label, ...rest] = line.split(/\s+[—–-]\s+/);
    return {
      label: (label ?? line).slice(0, 120),
      detail: rest.join(" — ").slice(0, 400),
    };
  });
  const recommended = (sections.get("recommended next step") ?? "")
    .split("\n")[0]
    ?.replace(/^\s*[-*+]\s+/, "")
    .trim();

  const candidate = {
    summary: summary.slice(0, 1200),
    readiness: missing.length === 0 ? ("ready" as const) : ("not_ready" as const),
    missing,
    // The guide must always leave a person something to press, so its own
    // options are joined by the deterministic one rather than replacing it.
    options: options.length > 0 ? options : floor.options,
    recommended: (recommended || floor.recommended).slice(0, 120),
    questions: bullets(sections.get("questions") ?? ""),
    sourceVersionIds: input.versions.map((version) => version.id),
    origin: "agent" as const,
  };

  const validated = GuidanceRecord(candidate);
  return validated instanceof type.errors ? null : validated;
}
