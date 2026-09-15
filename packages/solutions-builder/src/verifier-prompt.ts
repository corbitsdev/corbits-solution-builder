/**
 * The completion judge's rubric — CL-8005.
 *
 * What the `delivery-verifier` agent is told: the confidence-level
 * definitions, how to read the evidence, and the shape of the answer it must
 * return. This is domain content, tuned against real build runs, so it lives
 * beside the agent kit rather than inside the hub's process supervisor
 * (`apps/hub/src/completion-judge.ts`), which keeps everything mechanical —
 * spawning the deliverable, building the mechanical ceiling, and clamping the
 * judge's answer to it.
 */
import { agentById } from "./kit.js";
import type { TargetVerification } from "./targets.js";

export type ConfidenceLevel = "none" | "low" | "medium" | "high";

export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ["none", "low", "medium", "high"];

/** The subset of `apps/hub`'s `ExecutionCheck` this prompt actually renders — self-reported worker test/typecheck results. */
export type JudgeExecutionCheck = {
  readonly kind: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly ok: boolean;
  readonly vacuous: boolean;
  readonly detail: string;
};

/** A human-readable line naming what was, and was not, exercised — appended to every verdict so the level is auditable, not merely asserted. */
export function coverageSummary(targets: readonly TargetVerification[]): string {
  return targets
    .map((t) => `${t.target} (${t.modality}): ${t.exercised ? (t.ranSuccessfully ? "ran" : "ran but failed") : "not exercised"}`)
    .join("; ");
}

const verifierRole = agentById("delivery-verifier");

/**
 * Built from the kit's own `delivery-verifier` role (mission, boundary)
 * rather than an invented persona — the same role BUILD_PLAN_V3 §8 already
 * assigns "per-target proof and exact human acceptance" to, adapted here for
 * one inline question instead of the full stage-9 markdown report.
 */
export function judgeSystemPrompt(): string {
  const mission = verifierRole?.mission ?? "Verify readiness against the manifest, and never accept on a human's behalf.";
  const boundary = verifierRole?.boundary ?? "Cannot accept, waive, or claim bytes it could not read.";
  return `You are the Delivery verifier (${mission}). This call is not the full stage-9 report — it is a mid-build check: given real evidence of the deliverable being exercised, you report how much confidence that evidence supports.

Boundary, unchanged here: ${boundary} An unknown is not a pass: a target nobody could exercise, or behaviour nobody observed, contributes nothing toward confidence.

How to read the evidence:
- The target verification transcripts are the ONLY first-class evidence of behaviour — what actually happened when the deliverable was run with real input. Ground every claim in what a transcript shows, never in what you would expect it to show.
- The worker's own test/typecheck results are included and labelled self-reported. They are corroboration at best. A green suite that ran nothing, or a check the worker deleted, must never raise your confidence — a deleted or vacuous check is a red flag, not neutral information.
- Compare the observed behaviour against what the requirements actually describe, not just "it printed something". Partial or stubbed functionality is not high confidence.

Pick exactly one level:
- "high": the deliverable was driven through its real modality with real input, and what it did matches what the requirements describe.
- "medium": it ran and produced real output, but the full requirement-described flow was not exercised, or the output only partly matches.
- "low": it exists and starts; nothing beyond that was established.
- "none": nothing could be exercised — no target ran, nothing was produced.

Respond with nothing but one JSON object, no prose, no code fences: {"level": "none"|"low"|"medium"|"high", "reasoning": string}. "reasoning" must cite the specific evidence behind your pick and name what would need to be true for a higher level. Your level is a ceiling clamp away from the caller's own account regardless — pick honestly, not optimistically.`;
}

export function judgePrompt(args: {
  plan: string;
  requirements: string;
  checks: JudgeExecutionCheck[];
  targets: TargetVerification[];
  diff: string;
  files: string[];
}): string {
  const targetsText = args.targets
    .map((t) => `### Target: ${t.target} (${t.modality})\n${t.transcript}`)
    .join("\n\n");
  const checksText = args.checks
    .map((check) => `- ${check.kind} (\`${check.command}\`): exit ${check.exitCode ?? "timeout"}, ok=${check.ok}, vacuous=${check.vacuous} — ${check.detail}`)
    .join("\n");

  return [
    "## Plan",
    args.plan.trim().length > 0 ? args.plan : "(no plan text was recorded)",
    "",
    "## Requirements",
    args.requirements.trim().length > 0 ? args.requirements : "(no requirements text was recorded)",
    "",
    "## Behaviour actually observed, per declared target (first-class evidence)",
    targetsText.length > 0 ? targetsText : "(no targets were declared)",
    "",
    "## The worker's own test/typecheck results — SELF-REPORTED, corroboration only, never sufficient alone",
    checksText.length > 0 ? checksText : "(none)",
    "",
    "## Workspace diff against the seeded baseline commit — what the worker actually produced",
    args.diff,
    "",
    "## Files the worker produced or changed",
    args.files.length > 0 ? args.files.join("\n") : "(none)",
    "",
    "Return the JSON verdict now.",
  ].join("\n");
}

/** Extracts and validates `{level, reasoning}` from the judge's raw reply. Returns null on anything unparseable — never guessed at. */
export function parseVerdict(text: string): { level: ConfidenceLevel; reasoning: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { level?: unknown; reasoning?: unknown };
    if (typeof parsed.level !== "string" || !CONFIDENCE_LEVELS.includes(parsed.level as ConfidenceLevel)) return null;
    if (typeof parsed.reasoning !== "string" || parsed.reasoning.trim().length === 0) return null;
    return { level: parsed.level as ConfidenceLevel, reasoning: parsed.reasoning };
  } catch {
    return null;
  }
}
