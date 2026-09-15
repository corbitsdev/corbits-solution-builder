/**
 * What a declared `targets` string means — the one place that knows both
 * axes of it. The frozen packet (BUILD_PLAN_V3 §6/§13) declares `targets:
 * string[]`, the modalities the deliverable must be usable through; that
 * declaration is read twice downstream — once to tell the worker what to
 * build, once to tell the completion judge what to verify — and both reads
 * must agree on what each string means, so the classification lives here
 * rather than being reimplemented at either call site.
 */

/** A declared target's modality. Only `"cli"` is actually exercised today; everything else is honestly reported as not exercised. */
export type TargetModality = "cli" | "web" | "api" | "desktop" | "other";

export type TargetVerification = {
  readonly target: string;
  readonly modality: TargetModality;
  /** Whether this target was actually run, to any degree, rather than left unexercised. */
  readonly exercised: boolean;
  /** For an exercised target: whether real input drawn from the requirements was fed to it, rather than an immediate EOF. */
  readonly realInputFed: boolean;
  readonly ranSuccessfully: boolean;
  readonly producedOutput: boolean;
  /** What happened, in enough detail for a human — or the judge — to read the actual behaviour, or to see why nothing could be established. */
  readonly transcript: string;
};

export function classifyTarget(target: string): TargetModality {
  const t = target.toLowerCase();
  if (/\bcli\b|terminal|command[- ]?line|console app|\bshell\b/.test(t)) return "cli";
  if (/\bweb\b|browser|website|webapp|\bspa\b|frontend/.test(t)) return "web";
  if (/\bapi\b|\bservice\b|\bserver\b|backend|\bhttp\b|\brest\b|grpc/.test(t)) return "api";
  if (/desktop|electron|installable|installer|native app|macos app|windows app/.test(t)) return "desktop";
  return "other";
}

/** What a target's modality asks the worker to expose, and how the completion judge will exercise it — true to `verifyTarget` in `apps/hub/src/completion-judge.ts`, so this never promises checking that does not exist. */
const GUIDANCE: Record<TargetModality, string> = {
  cli: "The deliverable must be runnable as a command. It will be exercised by running it and feeding it real input drawn from the requirements on stdin, then checking that it runs successfully and produces output. To be runnable, it must be startable from the workspace root: declare a `start` script in the root `package.json` (the plainest way), or a `bin` entry, or `main` pointing at the entry file. A target nobody can start contributes nothing toward completion.",
  web: "The deliverable must be usable as a browser-run web app. No web verification is implemented yet — this target will be reported as not exercised, so it contributes no confidence toward completion on its own.",
  api: "The deliverable must expose a network service (HTTP/REST/gRPC). No API verification is implemented yet — this target will be reported as not exercised, so it contributes no confidence toward completion on its own.",
  desktop: "The deliverable must be an installable desktop app. No desktop verification is implemented yet — this target will be reported as not exercised, so it contributes no confidence toward completion on its own.",
  other: "This target's modality is not recognized, so no verification is implemented for it — it will be reported as not exercised and contributes no confidence toward completion on its own.",
};

/**
 * Per-declared-target guidance for the worker prompt: what each target asks
 * the deliverable to expose, and how it will actually be exercised. A
 * target nobody can exercise contributes nothing toward completion, so this
 * says so plainly rather than letting a bare target name imply a check that
 * does not exist.
 */
export function targetGuidance(targets: readonly string[]): string {
  return targets.map((target) => `- "${target}" (${classifyTarget(target)}): ${GUIDANCE[classifyTarget(target)]}`).join("\n");
}

/**
 * What a person picks at freeze time, in their own words rather than the
 * modality's machine name — the client reads this to build the picker
 * instead of retyping the vocabulary, and the canonical `target` string it
 * sends back is exactly what `classifyTarget` places into that same
 * modality. `"other"` has no entry here: it is not something a person
 * chooses, only what an unclassifiable value collapses to.
 */
export const SELECTABLE_TARGETS: ReadonlyArray<{
  readonly target: string;
  readonly modality: Exclude<TargetModality, "other">;
  readonly label: string;
  /** Whether choosing this target actually gets exercised at verification time, today. */
  readonly verified: boolean;
}> = [
  { target: "cli", modality: "cli", label: "A command you run in a terminal", verified: true },
  { target: "web", modality: "web", label: "A website", verified: false },
  { target: "api", modality: "api", label: "A service other software calls", verified: false },
  { target: "desktop", modality: "desktop", label: "An app you install", verified: false },
];
