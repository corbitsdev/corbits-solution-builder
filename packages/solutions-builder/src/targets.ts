/**
 * What a declared `targets` string means — the one place that knows both
 * axes of it. The frozen packet (BUILD_PLAN_V3 §6/§13) declares `targets:
 * string[]`, the modalities the deliverable must be usable through; that
 * declaration is read twice downstream — once to tell the worker what to
 * build, once to tell the completion judge what to verify — and both reads
 * must agree on what each string means, so the classification lives here
 * rather than being reimplemented at either call site.
 */

/** A declared target's modality. `"cli"`, `"web"` and `"api"` have a verifier
 *  implemented (`target-verify.ts`); `"desktop"` and `"other"` are honestly
 *  reported as not exercised. */
export type TargetModality = "cli" | "web" | "api" | "desktop" | "other";

/**
 * The packaging rule for what a build engineer ships, independent of the
 * stack's runtime mode (`StackMode` in `stack.ts`). A person never sees
 * package names — this is what "how it will actually run" cashes out to on
 * disk. CL-8863.
 *
 * `plain`/`inference`/`agent`/`local-workflow` (no hub) all package the same
 * way: one self-contained artifact, no Docker, no Postgres, no external
 * service, unless a requirement forces one and the frozen stack record says
 * so. `hub`-mode apps are the one exception: they run on the platform
 * (`@corbits/embedded-host` + `embed-hub`), not as a standalone binary.
 */
export const PORTABLE_PACKAGING_GUIDANCE = `A single-user or small-team app ships as one self-contained artifact, not a
service someone else has to operate:
- Compile it with \`bun build --compile\`, once per target OS/arch. The
  output is a single binary; there is nothing else to install.
- Serve the built UI from a local Hono server the binary starts itself, and
  open the person's browser at its URL. There is no separate frontend host.
- Store data in SQLite (\`bun:sqlite\`), a file next to the binary.
- No Docker, no Postgres, and no external service — unless the frozen stack
  record (\`StackRecord\` in \`stack.ts\`) cites a requirement that forces one.

The one exception is a \`"hub"\`-mode stack: that app is not compiled and
shipped standalone. It runs on \`@corbits/embedded-host\` (with \`embed-hub\`),
the platform's own process, because the requirement that put it in hub mode
(multi-person, multi-tenant, or cloud-later) is exactly the thing a lone
compiled binary cannot do.`;

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

/**
 * What a target's modality asks the worker to expose, and how it will be
 * exercised.
 *
 * `verifyApiTarget` and `verifyWebTarget` (`target-verify.ts`, this package)
 * implement the `api` and `web` checks described here; nothing in this repo
 * calls them yet — see that file's header for exactly where they need to be
 * wired in. `verifyCliTarget` (the `cli` check) has no implementation left
 * in this repo at all: it existed in the deleted `apps/hub/src/completion-judge.ts`
 * (CL-8340, commit ebf6e896) and was not resurrected here.
 */
const GUIDANCE: Record<TargetModality, string> = {
  cli: "The deliverable must be runnable as a command. It will be exercised by running it and feeding it real input drawn from the requirements on stdin, then checking that it runs successfully and produces output. To be runnable, it must be startable from the workspace root: declare a `start` script in the root `package.json` (the plainest way), or a `bin` entry, or `main` pointing at the entry file. A target nobody can start contributes nothing toward completion.",
  web: "The deliverable must be usable as a browser-run web app. It will be exercised by starting it, waiting for its port to open, then fetching `/` over plain HTTP and checking for a 200 with an HTML body, plus one referenced static asset (a script or stylesheet) also fetched and checked for a 200. This is an HTTP-response check, not a browser: no DOM, no JavaScript execution, no console-error capture, and no scripted user flow — this repo has no headless browser (no playwright, no puppeteer). A page that only renders correctly once its own JavaScript runs is not covered, and that gap is reported, not hidden.",
  api: "The deliverable must expose a network service (HTTP/REST/gRPC). It will be exercised by starting it, waiting for its port to open, then sending a GET to each declared route and recording the status and body it returned. A route that errors, times out, or never responds is reported as such, not silently skipped.",
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
  /** Whether choosing this target actually gets exercised at verification time, today. `false` here means no live call site runs the check yet, not that no implementation exists — see `target-verify.ts` for `web`/`api`. */
  readonly verified: boolean;
}> = [
  { target: "cli", modality: "cli", label: "A command you run in a terminal", verified: true },
  { target: "web", modality: "web", label: "A website", verified: false },
  { target: "api", modality: "api", label: "A service other software calls", verified: false },
  { target: "desktop", modality: "desktop", label: "An app you install", verified: false },
];
