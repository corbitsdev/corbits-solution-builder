/**
 * Runs a deliverable to see whether it does anything, rather than trusting
 * that its files exist. Shared by `delivery.ts` (verification at delivery
 * time) and `corbits-exec.ts` (verification during the build loop, so the
 * loop can stop on a passing deliverable instead of on silence) — one
 * implementation of "does this deliverable work", because two would drift
 * without anyone noticing.
 *
 * Deliberately narrow, not a sandbox (that is CL-7956's job):
 *   - one bounded child process per check, cwd pinned to the workspace,
 *     stdin closed so nothing can block waiting for input;
 *   - a hard wall-clock timeout per check, escalating from SIGTERM to
 *     SIGKILL, so a hang cannot stall verification forever;
 *   - stdout/stderr are drained to a bounded tail as they arrive, never
 *     buffered in full, so a runaway writer cannot exhaust memory;
 *   - the environment is trimmed to PATH plus a scratch HOME made fresh for
 *     the run and discarded after it, not the host process's full env or its
 *     real home directory — so generated code cannot reach the operator's
 *     `~/.ssh`, `~/.aws`, `~/.npmrc`, or git credential helpers.
 * What it does NOT do: no filesystem, network, or process-namespace
 * isolation.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

const ENTRY_POINT_TIMEOUT_MS = 15_000;
const SCRIPT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_TAIL_BYTES = 4_000;

/** Conventional CLI entry points tried when `package.json` names none. */
const ENTRY_POINT_CANDIDATES = ["src/cli.ts", "src/index.ts", "src/main.ts", "index.ts", "main.ts", "bin/cli.ts"];

/** File name patterns a human would recognise as a test, whether or not the runner also does. */
const TEST_LIKE_PATTERN = /(^|[._-])(test|spec)s?([._-]|$)/i;
/**
 * Files a `typecheck` script could plausibly be typechecking. Ambient
 * declaration files (`*.d.ts`, `*.d.mts`, `*.d.cts`) are excluded on
 * purpose: a `.d.ts` declares types, it contains no logic of its own, and
 * it is exactly what the workspace seed writes (`types/global.d.ts`, so
 * `tsc --noEmit` doesn't hard-error on an otherwise-empty project) — a
 * declaration file existing proves the seed ran, never that a deliverable
 * was written.
 */
const SOURCE_FILE_PATTERN = /(?<!\.d)\.(ts|tsx|mts|cts)$/i;
/**
 * Directories excluded from source/test discovery: VCS and build noise, and
 * — same principle as `.d.ts` above — the bridge's own reserved directories.
 * `.corbits/` and `.agents/` are tooling the seed writes for the worker to
 * read (the packet, the platform skills, the turn-report hook), never part
 * of the deliverable; a file the seed drops there must not be able to stand
 * in for one the worker wrote.
 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".corbits", ".agents"]);

export type PackageManifest = { scripts?: Record<string, string>; main?: string };

export type ExecutionKind = "entry_point" | "test" | "typecheck";

/** What ran, how it was bounded, and what it produced — never just an exit code. */
export type ExecutionCheck = {
  readonly kind: ExecutionKind;
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Whether this check counts as passing. False blocks delivery like a required descriptor would. */
  readonly ok: boolean;
  /**
   * True when the check passed without exercising anything: `test` with no
   * test files to collect, `typecheck` with no source files to typecheck.
   * Both are legitimate on a real deliverable that simply has no tests, or
   * is untyped — but on an otherwise-empty workspace they pass for free,
   * proving nothing about whether a deliverable exists. An entry point is
   * never vacuous: it either actually ran and produced output, or it
   * didn't. Only meaningful when `ok` is true; a failing check is never
   * vacuous, it is evidence of its own.
   */
  readonly vacuous: boolean;
  readonly detail: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
};

/** Keeps a relative path inside the workspace root it claims to be under. */
export function containedPath(root: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const resolved = normalize(join(root, relative));
  return resolved.startsWith(normalize(root) + "/") ? resolved : null;
}

/** Reads a pipe to a bounded tail: the last `maxBytes`, never the whole stream. */
async function drainTail(pipe: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
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

/** Runs one command to completion or to its timeout, whichever comes first. */
async function execBounded(
  command: string[],
  cwd: string,
  timeoutMs: number,
  home: string,
): Promise<{ exitCode: number | null; timedOut: boolean; stdoutTail: string; stderrTail: string }> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Not the host's own env, and not the host's own home directory either:
    // `HOME` is where credentials live (`~/.ssh`, `~/.aws`, `~/.npmrc`, git
    // credential helpers), so generated code gets PATH to find tools plus a
    // scratch HOME made fresh for this run, nothing it could read as a
    // credential or exfiltrate.
    env: { PATH: process.env.PATH ?? "", HOME: home },
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, timeoutMs);
  const [stdoutTail, stderrTail] = await Promise.all([
    drainTail(child.stdout, OUTPUT_TAIL_BYTES),
    drainTail(child.stderr, OUTPUT_TAIL_BYTES),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  return { exitCode: timedOut ? null : exitCode, timedOut, stdoutTail, stderrTail };
}

/** The command to run the deliverable itself, or null when none is discoverable. */
export async function discoverEntryPoint(workspaceRoot: string, pkg: PackageManifest | null): Promise<string[] | null> {
  // `--silent` matters here: without it `bun run <script>` echoes "$ <command>"
  // to stdout, which would read as output the deliverable itself never wrote.
  if (pkg?.scripts?.start) return ["bun", "run", "--silent", "start"];
  if (typeof pkg?.main === "string" && containedPath(workspaceRoot, pkg.main)) return ["bun", "run", pkg.main];
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    const resolved = containedPath(workspaceRoot, candidate);
    if (resolved && (await Bun.file(resolved).exists())) return ["bun", "run", candidate];
  }
  return null;
}

async function runEntryPoint(command: string[], workspaceRoot: string, home: string): Promise<ExecutionCheck> {
  const raw = await execBounded(command, workspaceRoot, ENTRY_POINT_TIMEOUT_MS, home);
  const producedOutput = raw.stdoutTail.trim().length > 0 || raw.stderrTail.trim().length > 0;
  const ok = !raw.timedOut && raw.exitCode === 0 && producedOutput;
  const detail = raw.timedOut
    ? `entry point exceeded ${ENTRY_POINT_TIMEOUT_MS}ms and was killed`
    : raw.exitCode !== 0
      ? `entry point exited ${raw.exitCode}`
      : !producedOutput
        ? "entry point exited 0 but produced no output on stdout or stderr"
        : "entry point ran and produced output";
  return {
    kind: "entry_point",
    command: command.join(" "),
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    ok,
    // Never vacuous: it either actually ran and produced output, or `ok` is false.
    vacuous: false,
    detail,
    stdoutTail: raw.stdoutTail,
    stderrTail: raw.stderrTail,
  };
}

/**
 * Every file under `root` whose name matches `pattern`, skipping VCS and
 * build noise. Bounded to a handful of hits — this exists to tell "none
 * exist" from "some exist", not to enumerate a whole tree.
 */
async function findFiles(root: string, pattern: RegExp, limit: number): Promise<string[]> {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (hits.length >= limit) return;
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (hits.length >= limit) return;
      if (item.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(item.name)) continue;
        await walk(join(dir, item.name));
      } else if (item.isFile() && pattern.test(item.name)) {
        hits.push(join(dir, item.name).slice(root.length + 1));
      }
    }
  }
  await walk(root);
  return hits;
}

/**
 * Every file under `root` whose name looks like a test to a human — `test`
 * or `spec` set off by a separator, e.g. `test_icp.ts`, `icp.test.ts`,
 * `__tests__/icp.ts` — regardless of whether the declared test runner's own
 * glob would collect it.
 */
function findTestLikeFiles(root: string, limit = 5): Promise<string[]> {
  return findFiles(root, TEST_LIKE_PATTERN, limit);
}

/**
 * Whether `root` holds anything a `typecheck` script could plausibly be
 * typechecking. `tsc --noEmit` exits 0 on a project with zero matching
 * files, exactly like a real pass — this is what tells the two apart.
 */
async function hasTypecheckableSource(root: string): Promise<boolean> {
  const hits = await findFiles(root, SOURCE_FILE_PATTERN, 1);
  return hits.length > 0;
}

async function runDeclaredScript(kind: "test" | "typecheck", workspaceRoot: string, home: string): Promise<ExecutionCheck> {
  const command = ["bun", "run", "--silent", kind];
  const raw = await execBounded(command, workspaceRoot, SCRIPT_TIMEOUT_MS, home);
  // `bun test` exits 1 when it finds zero test files under the deliverable —
  // the same exit code a genuinely failing suite produces. Seeding always
  // declares a `test` script, so a deliverable nobody wrote tests for would
  // otherwise be blocked from delivery by accident, indistinguishable from
  // one whose tests actually fail. Read from bun's own message, "no tests
  // exist" is treated as passing — UNLESS the workspace holds files that look
  // like tests to a human (e.g. `tests/test_icp.ts`, which bun's `*.test.ts`
  // glob never collects): a worker that wrote tests bun could not find has
  // not passed, it has produced dead weight indistinguishable from nothing at
  // all, and that is a failure worth reporting, not a pass.
  const bunFoundNothing = kind === "test" && !raw.timedOut && /No tests found!|0 test files matching/.test(raw.stderrTail);
  const misnamedTests = bunFoundNothing ? await findTestLikeFiles(workspaceRoot) : [];
  const noTestFiles = bunFoundNothing && misnamedTests.length === 0;
  const ok = !raw.timedOut && (raw.exitCode === 0 || noTestFiles);
  // `tsc --noEmit` exits 0 with nothing to say when it typechecks zero
  // files — passing for the same reason `bun test` passes on zero tests:
  // there was nothing to fail. Only checked when the run otherwise passed;
  // a real failure is never vacuous.
  const noSourceFiles = kind === "typecheck" && ok && !(await hasTypecheckableSource(workspaceRoot));
  const vacuous = noTestFiles || noSourceFiles;
  const detail = raw.timedOut
    ? `${kind} exceeded ${SCRIPT_TIMEOUT_MS}ms and was killed`
    : noTestFiles
      ? "no test files were found; not treated as a failure"
      : misnamedTests.length > 0
        ? `bun collected no test files, but found what look like tests it will never run: ${misnamedTests.join(", ")} — rename them to match bun's test glob (*.test.ts, *_test.ts, etc.)`
        : noSourceFiles
          ? "typecheck passed, but no .ts/.tsx source files exist to typecheck"
          : ok
            ? `${kind} passed`
            : `${kind} exited ${raw.exitCode}`;
  return {
    kind,
    command: command.join(" "),
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    ok,
    vacuous,
    detail,
    stdoutTail: raw.stdoutTail,
    stderrTail: raw.stderrTail,
  };
}

/**
 * Runs the deliverable's own entry point, and its declared tests and
 * typecheck, inside `workspaceRoot`. Nothing here is presence checking —
 * every item is a process that actually ran, or an explicit record that it
 * did not. An empty array means no runnable check was discoverable at all
 * (no entry point, no `test` or `typecheck` script) — that is not the same
 * as passing, and callers must not treat it as proof of completion.
 */
export async function runExecutionChecks(workspaceRoot: string): Promise<ExecutionCheck[]> {
  const pkgPath = join(workspaceRoot, "package.json");
  const pkg: PackageManifest | null = (await Bun.file(pkgPath).exists())
    ? (JSON.parse(await Bun.file(pkgPath).text()) as PackageManifest)
    : null;

  // One scratch HOME for every check in this run, made fresh and discarded
  // after — never the host's real home directory (see the file header).
  const home = await mkdtemp(join(tmpdir(), "solutions-builder-deliverable-home-"));
  try {
    const checks: ExecutionCheck[] = [];
    const entry = await discoverEntryPoint(workspaceRoot, pkg);
    if (entry) checks.push(await runEntryPoint(entry, workspaceRoot, home));
    for (const kind of ["test", "typecheck"] as const) {
      if (pkg?.scripts?.[kind]) checks.push(await runDeclaredScript(kind, workspaceRoot, home));
    }
    return checks;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Whether `checks` prove a working deliverable exists — not merely that
 * nothing failed. Every check must pass, exactly as before, but passing is
 * not sufficient on its own: on a workspace with no source and no entry
 * point, a seeded `test` script passes because there are no tests to run and
 * a seeded `typecheck` script passes because there is nothing to typecheck —
 * both checks green, nothing built. So at least one check must also be
 * non-vacuous, i.e. must have actually exercised something: an entry point
 * that ran and produced output, a test suite that ran real tests, a
 * typecheck over real source. `null` or `[]` (no check was even
 * discoverable) is never enough either.
 *
 * Deliberately not `produced.changed`/a workspace-diff check: a continued
 * attempt legitimately resumes a workspace that already holds finished work,
 * and an invocation that changes nothing there is not evidence the
 * deliverable is missing. This rule asks "does the workspace hold a working
 * deliverable", not "did this invocation add to it".
 */
export function hasWorkingDeliverable(checks: ExecutionCheck[] | null): boolean {
  if (checks === null || checks.length === 0) return false;
  return checks.every((check) => check.ok) && checks.some((check) => !check.vacuous);
}
