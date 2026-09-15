/**
 * Stage 8's completion judge — CL-8005.
 *
 * `hasWorkingDeliverable` (execution-checks.ts) used to be the build loop's
 * own verdict: a boolean read off the worker's own `test`/`typecheck`
 * scripts. It produced five false "complete" verdicts in real runs, each by
 * a different route a worker's own edits could always find (an empty
 * workspace's seeded scripts pass for free; a stub `.d.ts` or an empty
 * `*.test.ts` file reads as "source" or "a suite"; a seeded check a worker
 * deletes just vanishes). The rule was the wrong shape, not one patch short.
 *
 * What replaces it is not another boolean. Two things changed at once:
 *
 *   1. The worker's own tests are demoted. A test suite is self-graded — the
 *      worker wrote it — so a green suite is corroboration at best and is
 *      never, on its own, evidence of anything. What counts as first-class
 *      evidence is the deliverable actually being *used*, in the modality
 *      the frozen packet declares (`targets`, BUILD_PLAN_V3 §6/§13): a CLI
 *      is run with real input drawn from the requirements and its behaviour
 *      is captured; a modality this bridge cannot yet drive (a browser-run
 *      web app, an installable desktop app, a network service) is reported
 *      as not exercised — never faked, never silently treated as passing.
 *
 *   2. The verdict is a confidence level, not a pass/fail. How much
 *      confidence the evidence supports is read off what was *actually
 *      exercised* — computed mechanically, never asserted by the model — and
 *      an agent (the kit's own `delivery-verifier` role, BUILD_PLAN_V3 §8:
 *      "per-target proof and exact human acceptance", never an accept/waive
 *      decision of its own) judges, within that ceiling, whether the
 *      observed behaviour actually matches what the requirements describe.
 *      The model's answer can only be clamped down from the mechanical
 *      ceiling, never raised past it — "high" is structurally unreachable
 *      without evidence the thing ran with real input and produced output,
 *      whatever the model says.
 *
 * The build loop keys off the level: it stops (`"complete"`) only at
 * `"high"`; anything else keeps going, with the reasoning — which always
 * names what was and was not exercised, so it is auditable rather than
 * trusted — fed into the next continuation's prompt.
 *
 * Cost: computing the mechanical ceiling costs nothing beyond running the
 * deliverable, which the loop already needed to do. The judge — an
 * inference call — is only asked once that ceiling is `"medium"` or
 * `"high"`: below that (nothing exercised, or a bare start with no output),
 * there is no behaviour to interpret and the answer is already decided by
 * the facts alone. That is the only place a heuristic could not tell "ran"
 * from "matches the requirements", and the only place this pays for a call.
 *
 * Failure behaviour: an unreachable judge or an unparseable answer never
 * raises the level — it reports `"unavailable"`, keeps whatever the
 * mechanical ceiling already established, and the reasoning says the judge
 * could not be asked. The build loop treats that exactly like "not high
 * yet" and keeps going (or eventually stops on `turn_budget` /
 * `wall_clock_budget`), never on a rubber-stamped `"complete"`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXAMPLE_HEADING_PATTERN } from "@solutions-builder/app/requirements-example";
import { classifyTarget, type TargetVerification } from "@solutions-builder/app/targets";
import {
  coverageSummary,
  judgeSystemPrompt,
  judgePrompt,
  parseVerdict,
  CONFIDENCE_LEVELS,
  type ConfidenceLevel,
} from "@solutions-builder/app/verifier-prompt";
import { complete, type CompletionResult } from "./inference.js";
import { runExecutionChecks, discoverEntryPoint, type ExecutionCheck, type PackageManifest } from "./execution-checks.js";

export type { ConfidenceLevel, TargetVerification };
/** Re-exported so a caller validating an untrusted payload (`engine.ts`, the smoke scripts) can check a level without duplicating this list. */
export { CONFIDENCE_LEVELS, parseVerdict };

const LEVELS = CONFIDENCE_LEVELS;
const levelIndex = (level: ConfidenceLevel): number => LEVELS.indexOf(level);
const minLevel = (a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel => (levelIndex(a) <= levelIndex(b) ? a : b);

export type CompletionVerdict = {
  readonly level: ConfidenceLevel;
  readonly reasoning: string;
  /**
   * "mechanical" — the level was read off the coverage facts alone, because
   * nothing was exercised enough to need a semantic read. "judge" — an
   * agent read the transcripts and the requirements and picked a level,
   * clamped to the mechanical ceiling. "unavailable" — the ceiling allowed
   * asking, but the judge could not be reached or its answer could not be
   * read; the level reported is the mechanical ceiling, never raised by a
   * guess.
   */
  readonly source: "mechanical" | "judge" | "unavailable";
  /** The worker's own `test`/`typecheck` results — self-reported corroboration, never sufficient alone. */
  readonly checks: ExecutionCheck[];
  /** What was, and was not, actually exercised — the coverage a level rests on. */
  readonly targets: TargetVerification[];
};

/**
 * What `build.accept_evidence` (BUILD_PLAN_V3 §7) requires to exist before a
 * human can accept: the judge's verdict, stripped to the fields a decision
 * needs — never the full transcripts, which stay on the run's own event.
 */
export type VerifierReport = Pick<CompletionVerdict, "level" | "reasoning" | "source">;

export function verifierReportOf(verdict: CompletionVerdict): VerifierReport {
  return { level: verdict.level, reasoning: verdict.reasoning, source: verdict.source };
}

/**
 * Reads a `VerifierReport` back off an untrusted command payload. Returns
 * null for anything that is not a genuine verdict — absent, malformed, or a
 * shape someone hand-typed to look like one — so the caller can refuse
 * rather than accept a fabricated confidence level.
 */
export function readVerifierReport(value: unknown): VerifierReport | null {
  if (typeof value !== "object" || value === null) return null;
  const { level, reasoning, source } = value as Record<string, unknown>;
  if (typeof level !== "string" || !CONFIDENCE_LEVELS.includes(level as ConfidenceLevel)) return null;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) return null;
  if (source !== "mechanical" && source !== "judge" && source !== "unavailable") return null;
  return { level: level as ConfidenceLevel, reasoning, source };
}

// ---------------------------------------------------------------------------
// Target modality: dispatch to the one modality actually implemented (CLI).
// Classification itself (`classifyTarget`) lives in the packages module
// (`@solutions-builder/app/targets`) so the worker prompt and this judge
// agree on what each declared target means.

/**
 * Candidate example input, drawn from the requirements themselves rather
 * than invented: lines under a heading naming an example, a sample, a
 * walkthrough or a scenario, with a leading speaker label stripped (`You:`,
 * `Input:`, `Answer:`...). Bounded so a long requirements document cannot
 * turn into an unbounded transcript. Returns `[]`, honestly, when the
 * requirements describe no such section — nothing is fabricated to fill it.
 */
export function extractExampleInput(requirements: string, limit = 20): string[] {
  const collected: string[] = [];
  // The depth of the example's own heading while inside one, so a *deeper*
  // heading stays within it. A real requirements document writes the example
  // as `## Worked example` with `### Input` and `### Output` under it, and
  // treating those subheadings as the end of the section threw away the very
  // lines the example exists to provide -- observed on a real build, whose
  // example was present, well-formed, and invisible.
  let exampleDepth: number | null = null;
  let inFence = false;
  let inInput = false;
  let sawInputHeading = false;
  for (const raw of requirements.split("\n")) {
    // A fenced block inside the example is the example: keep what it holds
    // and drop the ``` markers, which are markup and not input anyone types.
    if (/^\s*(```|~~~)/.test(raw)) {
      if (exampleDepth !== null) inFence = !inFence;
      continue;
    }
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const depth = heading[1]!.length;
      const title = heading[2] ?? "";
      if (EXAMPLE_HEADING_PATTERN.test(title)) {
        exampleDepth = depth;
        inInput = false;
      } else if (exampleDepth !== null && depth <= exampleDepth) {
        exampleDepth = null;
        inInput = false;
      } else if (exampleDepth !== null) {
        // Inside the example, a subheading says which half this is. Feeding a
        // deliverable its own expected output would be evidence of nothing --
        // it could echo what it was handed and look correct.
        inInput = /\binput\b|\bgiven\b|\bwhen\b/i.test(title);
        sawInputHeading = sawInputHeading || inInput;
      }
      continue;
    }
    if (exampleDepth === null) continue;
    // Only skip non-input halves once the document has actually named one;
    // an example written as a flat block has no halves and is taken whole.
    if (sawInputHeading && !inInput) continue;
    const stripped = raw.replace(/^\s*[-*+]\s+/, "").trim();
    if (stripped.length === 0) continue;
    const withoutLabel = stripped
      .replace(/^(you|user|input|answer|reply|response|prompt)\s*:\s*/i, "")
      .replace(/^["“]|["”]$/g, "");
    if (withoutLabel.length === 0) continue;
    collected.push(withoutLabel);
    if (collected.length >= limit) break;
  }
  return collected;
}

const CLI_RUN_TIMEOUT_MS = 20_000;
const OUTPUT_TAIL_BYTES = 4_000;

async function drain(pipe: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!pipe) return "";
  const decoder = new TextDecoder();
  const reader = pipe.getReader();
  let tail = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = (tail + decoder.decode(value, { stream: true })).slice(-maxBytes);
  }
  return tail;
}

/** Runs `command` with `input` written to stdin and closed — a real invocation, not a shell simulation — bounded so a hang cannot stall a verification pass forever. */
async function runCliWithInput(
  command: string[],
  cwd: string,
  input: string,
  home: string,
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  if (input.length > 0) child.stdin.write(input);
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, CLI_RUN_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([drain(child.stdout, OUTPUT_TAIL_BYTES), drain(child.stderr, OUTPUT_TAIL_BYTES)]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  return { exitCode: timedOut ? null : exitCode, timedOut, stdout, stderr };
}

/**
 * The one modality this bridge actually drives: starts the deliverable's own
 * entry point (the same discovery `execution-checks.ts` uses) and feeds it
 * real input drawn from the requirements — never fabricated data — capturing
 * exactly what came back. This transcript, not the worker's own test suite,
 * is the judge's first-class evidence of behaviour.
 */
async function verifyCliTarget(target: string, workspaceRoot: string, requirements: string): Promise<TargetVerification> {
  const pkgPath = join(workspaceRoot, "package.json");
  const pkg: PackageManifest | null = (await Bun.file(pkgPath).exists())
    ? (JSON.parse(await Bun.file(pkgPath).text()) as PackageManifest)
    : null;
  const command = await discoverEntryPoint(workspaceRoot, pkg);
  if (!command) {
    return {
      target,
      modality: "cli",
      exercised: false,
      realInputFed: false,
      ranSuccessfully: false,
      producedOutput: false,
      transcript:
        "no runnable entry point was discoverable (no `start` script, no `main`, none of the conventional entry files) — nothing to run.",
    };
  }
  const input = extractExampleInput(requirements);
  const home = await mkdtemp(join(tmpdir(), "solutions-builder-judge-cli-"));
  try {
    const result = await runCliWithInput(command, workspaceRoot, input.length > 0 ? `${input.join("\n")}\n` : "", home);
    const producedOutput = result.stdout.trim().length > 0 || result.stderr.trim().length > 0;
    const ranSuccessfully = !result.timedOut && result.exitCode === 0;
    const transcript = [
      `$ ${command.join(" ")}`,
      input.length > 0
        ? `fed ${input.length} line(s) of input drawn from the requirements' own example/sample section:\n${input.map((line) => `> ${line}`).join("\n")}`
        : "no example input was found in the requirements (no heading naming an example, a sample, a walkthrough or a scenario); ran with stdin closed immediately (EOF)",
      `exit ${result.timedOut ? "timeout" : result.exitCode}`,
      result.stdout.trim().length > 0 ? `stdout:\n${result.stdout.trim()}` : "(no stdout)",
      result.stderr.trim().length > 0 ? `stderr:\n${result.stderr.trim()}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    return { target, modality: "cli", exercised: true, realInputFed: input.length > 0, ranSuccessfully, producedOutput, transcript };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Dispatches a declared target to the modality that can verify it.
 * Everything but `"cli"` is honestly reported as not exercised — this never
 * blocks or dead-ends the build (there is no modality this bridge cannot
 * report on), it simply contributes no confidence toward a level, exactly
 * like a target nobody could reach.
 */
function verifyTarget(target: string, workspaceRoot: string, requirements: string): Promise<TargetVerification> {
  const modality = classifyTarget(target);
  if (modality !== "cli") {
    return Promise.resolve({
      target,
      modality,
      exercised: false,
      realInputFed: false,
      ranSuccessfully: false,
      producedOutput: false,
      transcript: `no ${modality} verification is implemented yet for target "${target}" — it was not exercised. This does not fail the target: it simply contributes no confidence toward completion, and the gap is reported rather than hidden.`,
    });
  }
  return verifyCliTarget(target, workspaceRoot, requirements);
}

/**
 * The mechanical ceiling: the highest level the evidence alone could ever
 * support, before any semantic reading of whether the behaviour matches the
 * requirements. The judge's own answer is clamped to this — it can lower
 * the level, never raise it — which is what makes "high" structurally
 * unreachable without real, exercised behaviour, rather than merely
 * discouraged by a prompt.
 */
function mechanicalCeiling(targets: readonly TargetVerification[], checks: readonly ExecutionCheck[]): ConfidenceLevel {
  const exercised = targets.filter((t) => t.exercised);
  let ceiling: ConfidenceLevel = "none";
  if (exercised.some((t) => t.ranSuccessfully && t.producedOutput && t.realInputFed)) ceiling = "high";
  else if (exercised.some((t) => t.ranSuccessfully && t.producedOutput)) ceiling = "medium";
  else if (exercised.some((t) => t.ranSuccessfully)) ceiling = "low";
  // A failing or worker-deleted check (`checkSeededScriptSurvival`'s report
  // included) is a structural red flag, not merely a prompt instruction: it
  // caps the ceiling at "medium" regardless of how well the exercised
  // target behaved, so a worker cannot reach "high" by deleting the one
  // check that would have failed while its CLI happens to run.
  if (checks.some((check) => !check.ok)) ceiling = minLevel(ceiling, "medium");
  return ceiling;
}

/** The seed's own baseline commit — the root of the workspace's history, never a guess. */
async function baselineRootSha(workspaceRoot: string): Promise<string | null> {
  if (!(await Bun.file(join(workspaceRoot, ".git", "HEAD")).exists())) return null;
  const result = Bun.spawnSync(["git", "-C", workspaceRoot, "rev-list", "--max-parents=0", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.toString().trim().split("\n")[0];
  return sha || null;
}

/**
 * What the worker actually produced, against the immutable seed commit —
 * separable from what was seeded, and not something the worker's own edits
 * to `package.json` or anything else can alter after the fact. `.corbits`
 * and `.agents` are the bridge's own tooling, reseeded every attempt, and
 * are excluded exactly as `describeWorkspaceChange` (corbits-exec.ts)
 * excludes them.
 */
async function diffAgainstSeed(workspaceRoot: string): Promise<{ diff: string; files: string[] }> {
  const sha = await baselineRootSha(workspaceRoot);
  if (!sha) return { diff: "(no git baseline on this workspace — nothing to diff against)", files: [] };
  const pathspec = ["--", ".", ":!.corbits", ":!.agents"];
  const stat = Bun.spawnSync(["git", "-C", workspaceRoot, "diff", "--stat", sha, ...pathspec], { stdout: "pipe", stderr: "pipe" });
  const names = Bun.spawnSync(["git", "-C", workspaceRoot, "diff", "--name-only", sha, ...pathspec], { stdout: "pipe", stderr: "pipe" });
  const untracked = Bun.spawnSync(["git", "-C", workspaceRoot, "ls-files", "--others", "--exclude-standard", ...pathspec], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const statText = stat.exitCode === 0 ? stat.stdout.toString().trim() : "";
  const changedFiles = names.exitCode === 0 ? names.stdout.toString().split("\n").filter(Boolean) : [];
  const untrackedFiles = untracked.exitCode === 0 ? untracked.stdout.toString().split("\n").filter(Boolean) : [];
  const files = [...new Set([...changedFiles, ...untrackedFiles])].sort();
  const parts = [
    statText,
    untrackedFiles.length > 0 ? `${untrackedFiles.length} new untracked file(s):\n${untrackedFiles.join("\n")}` : "",
  ].filter((part) => part.length > 0);
  return { diff: parts.length > 0 ? parts.join("\n\n") : "(no changes against the seeded baseline)", files };
}

/**
 * Decides how much confidence the evidence in `workspaceRoot` supports,
 * against `plan` and `requirements`, for the declared `targets` (defaults to
 * a single implicit `"cli"` target when the packet declared none — every
 * workspace this bridge seeds is a local Bun CLI-shaped project until a
 * target says otherwise).
 *
 * `completeFn` defaults to the real inference port (`complete` in
 * inference.ts — the seam the stage specialists already use to reach the
 * operator's connected provider) and is overridable so tests can substitute
 * a deterministic stand-in without a live provider.
 *
 * The judge's model is chosen by the same rank-and-version pick every other
 * `complete()` call uses (`chooseModel` in inference.ts) — the operator's
 * connected provider catalogue, not the build worker's own model. The two
 * are different by construction: the worker is a separate CLI process
 * (`build-worker.ts`) invoked as its own binary with its own model
 * configuration, while the judge goes through this host's own inference
 * port. Nothing requires an operator to point them at the same provider.
 */
export async function judgeCompletion(
  args: {
    workspaceRoot: string;
    plan: string;
    requirements: string;
    targets?: readonly string[];
    usage?: { readonly projectId: string; readonly purpose: string };
  },
  completeFn: (request: Parameters<typeof complete>[0]) => Promise<CompletionResult> = complete,
): Promise<CompletionVerdict> {
  // `runExecutionChecks` also runs its own entry-point invocation, with no
  // input — superseded here by the target verification below, which runs
  // the real entry point with real input and is the authoritative account
  // of behaviour. Keeping the plain one around as "self-reported" evidence
  // would just contradict it (a CLI that only produces output once it is
  // fed input legitimately fails the input-less check), so only the
  // `test`/`typecheck` results are kept as self-reported corroboration.
  const checks = (await runExecutionChecks(args.workspaceRoot)).filter((check) => check.kind !== "entry_point");
  const declaredTargets = args.targets && args.targets.length > 0 ? args.targets : ["cli"];
  const targets = await Promise.all(declaredTargets.map((target) => verifyTarget(target, args.workspaceRoot, args.requirements)));
  const coverage = coverageSummary(targets);
  const ceiling = mechanicalCeiling(targets, checks);

  // Below "medium" there is no behaviour to interpret: nothing ran, or
  // something started and did nothing worth reading semantics into. The
  // facts alone already decide the level, so the judge is not asked.
  if (levelIndex(ceiling) < levelIndex("medium")) {
    return {
      level: ceiling,
      reasoning: `${
        ceiling === "none"
          ? "nothing could be exercised: no declared target ran."
          : "a target started but produced nothing that could be read as real behaviour."
      } Coverage: ${coverage}`,
      source: "mechanical",
      checks,
      targets,
    };
  }

  const { diff, files } = await diffAgainstSeed(args.workspaceRoot);

  try {
    const result = await completeFn({
      system: judgeSystemPrompt(),
      prompt: judgePrompt({ plan: args.plan, requirements: args.requirements, checks, targets, diff, files }),
      ...(args.usage ? { usage: args.usage } : {}),
      maxTokens: 1024,
      temperature: 0,
    });
    const parsed = parseVerdict(result.text);
    if (!parsed) {
      return {
        level: ceiling === "high" ? "medium" : ceiling,
        reasoning: `the completion judge's answer could not be read as a verdict, so the level is held at the mechanical ceiling rather than raised on a guess: ${result.text.slice(0, 500)}. Coverage: ${coverage}`,
        source: "unavailable",
        checks,
        targets,
      };
    }
    const level = minLevel(parsed.level, ceiling);
    return { level, reasoning: `${parsed.reasoning} Coverage: ${coverage}`, source: "judge", checks, targets };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      level: ceiling === "high" ? "medium" : ceiling,
      reasoning: `the completion judge could not be reached, so the level is held at the mechanical ceiling rather than raised on a guess: ${message}. Coverage: ${coverage}`,
      source: "unavailable",
      checks,
      targets,
    };
  }
}
