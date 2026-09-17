/**
 * Stage 8's senior-engineer panel — reviewing the build's evidence.
 *
 * Build plan section 8 defines `senior-engineer-panel` as stages 6 and 8:
 * four independent principals — application, quality, platform, security —
 * each with its own prompt, model, run and findings, "not a single synthetic
 * reviewer". Stage 6 already runs them, as agent steps inside the stage's own
 * revise loop, reviewing the architect's plan. Stage 8 has none. Its round
 * does reach the deployed workflow — `build.start_attempt` is delivered into
 * `revise-8` and the run parks there again when the attempt ends — but the
 * build itself runs host-side, as a subprocess `build-attempt.ts` and
 * `corbits-exec.ts` supervise. The workflow tracks the round; it does not run
 * the build, so there are no agent steps inside it for a reviewer to be one
 * of. This module is the same four-principal review, reached the way stage
 * 8's other host-side work already is: one inference call per principal
 * (`inference.ts`'s `complete()`, the same port `completion-judge.ts` uses),
 * each under its own kit system prompt, each persisted as its own version —
 * independent findings and independent provenance, never a merged verdict.
 *
 * Called once evidence exists to review: `recordStage8PanelReview` is wired
 * from `build-output.ts`'s `acceptBuildEvidence`, right after the evidence is
 * accepted. The panel has no gating authority (section 8: it "may require
 * revision, evidence or remediation" and "may not decide scope, open a gate
 * or grant anything"), so a review that fails to write is logged and never
 * blocks the acceptance that already committed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelPrincipals } from "@solutions-builder/app/kit";
import { skillTextFor } from "@solutions-builder/app/seed-kit";
import { assumptionsIn, questionsIn } from "@solutions-builder/app/document";
import { complete, type CompletionRequest, type CompletionResult } from "./inference.js";
import { writeArtifact } from "./projects.js";
import { ArtifactDraft } from "./domain.js";
import { type Actor } from "./command-dispatch.js";
import { type BuildArchive, buildBytesOf } from "./build-output.js";
import { stageInputsForSmoke } from "./stage-runs.js";
import { type } from "arktype";

/** One principal's outcome: a written version, or the reason it has none. */
export type PanelReviewOutcome = {
  readonly principal: string;
  readonly title: string;
  readonly nodeId: string | null;
  readonly error: string | null;
};

/** What a build's final event reports about the attempt, read straight off `bridge.final`. */
export type BuildAttemptReport = {
  readonly worker: string | null;
  readonly exitStatus: number | null;
  readonly turns: number | null;
  readonly toolCalls: number | null;
  readonly continuedFrom: string | null;
};

/** The archive's own file listing, via `tar -tzf` — no need to unpack it to read what it holds. */
async function archiveFileList(content: string): Promise<string[]> {
  const bytes = await buildBytesOf(content);
  if (!bytes) return [];
  const dir = await mkdtemp(join(tmpdir(), "build-review-archive-"));
  try {
    const path = join(dir, "evidence.tar.gz");
    await writeFile(path, bytes);
    const result = Bun.spawnSync(["tar", "-tzf", path], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The evidence as the panel reads it: the archive's own facts, never a claim the worker made. */
async function evidenceSummary(archive: BuildArchive, content: string, report: BuildAttemptReport): Promise<string> {
  const files = await archiveFileList(content);
  return [
    "## Build archive",
    `- name: ${archive.name}`,
    `- sha256: ${archive.sha256}`,
    `- size: ${archive.sizeBytes} bytes`,
    `- unpacks into: ${archive.root}/`,
    "",
    "## The attempt that produced it",
    `- worker: ${report.worker ?? "(not recorded)"}`,
    `- exit status: ${report.exitStatus ?? "(not recorded)"}`,
    `- turns: ${report.turns ?? "(not recorded)"}`,
    `- tool calls: ${report.toolCalls ?? "(not recorded)"}`,
    report.continuedFrom ? `- continued from attempt: ${report.continuedFrom}` : "",
    "",
    "## Files inside the archive",
    files.length > 0 ? files.join("\n") : "(the archive's contents could not be listed)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Runs every panel principal independently against the same evidence and
 * persists whichever reviews write successfully. One principal's failure —
 * an empty reply, a provider outage — is that principal's alone: the other
 * three are still recorded, exactly as a stakeholder's failed package at
 * stage 5 does not hold up the others.
 */
export async function reviewBuildEvidence(
  args: {
    readonly projectId: string;
    readonly actor: Actor;
    readonly planAndApprovedInputs: string;
    readonly evidence: string;
    readonly sourceVersionIds: readonly string[];
  },
  deps: {
    readonly completeFn?: (request: CompletionRequest) => Promise<CompletionResult>;
    readonly persist?: typeof writeArtifact;
  } = {},
): Promise<PanelReviewOutcome[]> {
  const completeFn = deps.completeFn ?? complete;
  const persist = deps.persist ?? writeArtifact;

  const prompt = [
    "## Plan and approved inputs",
    args.planAndApprovedInputs,
    "",
    "## The build's evidence",
    args.evidence,
    "",
    "Review the evidence above against the plan and the approved inputs. Produce your review now, in the headings your instructions specify.",
  ].join("\n");

  return Promise.all(
    panelPrincipals().map(async (role): Promise<PanelReviewOutcome> => {
      const title = role.title.replace("Senior engineer — ", "");
      try {
        const result = await completeFn({
          system: `${role.system}\n\n${skillTextFor(role)}`,
          prompt,
          usage: { projectId: args.projectId, purpose: `sb-stage8-review-${role.id}` },
          maxTokens: 4096,
          temperature: role.temperature,
        });
        const cleaned = result.text.trim();
        if (!cleaned) throw new Error(`${role.title} returned an empty review`);

        const draft = ArtifactDraft({
          projectId: args.projectId,
          kind: "build_review",
          variant: title,
          title: `${role.title} — stage 8`,
          content: cleaned,
          mediaType: "text/markdown",
          sourceVersionIds: [...args.sourceVersionIds],
          provenance: {
            producer: "agent",
            agentRole: role.id,
            providerId: result.providerId,
            model: result.model,
            promptKey: role.promptKey,
            promptVersion: 1,
            modelKey: role.modelKey ?? `sb-model-${role.id}`,
            assumptions: assumptionsIn(cleaned),
            questions: questionsIn(cleaned),
          },
        });
        if (draft instanceof type.errors) throw new Error(`${role.title}'s review failed boundary validation: ${draft.summary}`);

        const written = await persist(draft, args.actor);
        return { principal: role.id, title, nodeId: written.nodeId, error: null };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { principal: role.id, title, nodeId: null, error: message };
      }
    }),
  );
}

/**
 * The one call site: given an accepted build's archive and the attempt that
 * produced it, gathers the plan and every approved input, renders the
 * archive's own facts, and runs the four-principal review. Never throws —
 * the panel is advisory, and a review that could not be written is logged,
 * not surfaced as a failure of the acceptance that already committed.
 */
export async function recordStage8PanelReview(args: {
  readonly projectId: string;
  readonly actor: Actor;
  readonly archive: BuildArchive;
  readonly content: string;
  readonly report: BuildAttemptReport;
}): Promise<PanelReviewOutcome[]> {
  try {
    const [planAndApprovedInputs, evidence] = await Promise.all([
      stageInputsForSmoke(args.projectId, 8),
      evidenceSummary(args.archive, args.content, args.report),
    ]);
    return await reviewBuildEvidence({
      projectId: args.projectId,
      actor: args.actor,
      planAndApprovedInputs,
      evidence,
      sourceVersionIds: [args.archive.nodeId],
    });
  } catch (cause) {
    console.error(`[stage 8] ${args.projectId}: the panel's review of the evidence could not be recorded:`, cause);
    return [];
  }
}
