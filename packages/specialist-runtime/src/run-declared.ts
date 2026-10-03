/**
 * What a build attempt declares about running itself, and the host's own
 * run of it. The worker is told (`apps/hub/src/build-attempts.ts`) to leave
 * `RUN_DECLARATION` naming its test command and how to start it; when the
 * host packages the attempt it runs the tests and starts the target from
 * the attempt directory (`verify.ts`), each bounded in time and confined to
 * this machine's network where the platform can confine it. A declaration
 * that is missing or does not parse is a failed check, never a skipped one.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import type { VerificationItem } from "./delivery.js";
import { networkLine } from "./host-environment.js";
import { describeRun, runBounded } from "./target-verify.js";
import { classifyTarget } from "./targets.js";
import type { TargetProbe } from "./verify.js";

export const RUN_DECLARATION = ".solutions-builder/run.json";

const TEST_TIMEOUT_MS = 5 * 60_000;
/** A test suite's own output is longer than a checklist row; its tail is what says how it ended. */
const TEST_OUTPUT_KEEP = 1_500;

const RunDeclaration = type({
  test: "string > 0",
  start: "string > 0",
  "port?": "1 <= number.integer <= 65535",
  "routes?": type(/^\//).array(),
  "smoke?": "string > 0",
});
export type RunDeclaration = typeof RunDeclaration.infer;

/** The attempt's declaration, or why there is none to run. */
async function readRunDeclaration(dir: string): Promise<RunDeclaration | string> {
  let text: string;
  try {
    text = await readFile(join(dir, RUN_DECLARATION), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return `the attempt left no ${RUN_DECLARATION}`;
    return `${RUN_DECLARATION} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  try {
    const parsed = RunDeclaration(JSON.parse(text));
    return parsed instanceof type.errors ? `${RUN_DECLARATION} is not usable: ${parsed.summary}` : parsed;
  } catch (cause) {
    return `${RUN_DECLARATION} does not parse: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/** Runs the declared test command in the attempt directory and records how it ended. */
async function runDeclaredTests(dir: string, command: string): Promise<VerificationItem> {
  const run = await runBounded({ command: ["sh", "-c", command], cwd: dir, timeoutMs: TEST_TIMEOUT_MS, env: { CI: "1" } });
  const passed = !run.timedOut && run.exitStatus === 0;
  return {
    category: "tests",
    path: "tests",
    required: true,
    status: passed ? "verified" : "failed",
    checkedBy: "tool",
    detail: `run by the host: \`${command}\` ${describeRun(run, TEST_TIMEOUT_MS)}; ${networkLine(run.confined)}\n${run.output.trim().slice(-TEST_OUTPUT_KEEP) || "(no output)"}`,
  };
}

/** A check that could not run because of what the attempt declared. */
function notRun(category: "tests" | "receipts", path: string, reason: string): VerificationItem {
  return { category, path, required: true, status: "failed", checkedBy: "tool", detail: `not run: ${reason}` };
}

/**
 * The attempt's tests, run, and its target as the attempt declares it: a
 * probe for the caller to start, or a failed item saying why there is none.
 */
export async function runDeclared(dir: string, target: string): Promise<{ tests: VerificationItem; target: TargetProbe | VerificationItem }> {
  const declaration = await readRunDeclaration(dir);
  if (typeof declaration === "string") return { tests: notRun("tests", "tests", declaration), target: notRun("receipts", `target:${target}`, declaration) };
  const probe = declaredProbe(target, declaration);
  return { tests: await runDeclaredTests(dir, declaration.test), target: typeof probe === "string" ? notRun("receipts", `target:${target}`, probe) : probe };
}

/** The declared target as a probe: a `cli` target's smoke command (its `--help` unless it names one), or a `web`/`api` target's start command, port and routes. */
function declaredProbe(target: string, declaration: RunDeclaration): TargetProbe | string {
  const modality = classifyTarget(target);
  if (modality === "cli") return { target, command: ["sh", "-c", declaration.smoke ?? `${declaration.start} --help`], port: 0, routes: [] };
  if (modality !== "web" && modality !== "api") return { target, command: ["sh", "-c", declaration.start], port: 0, routes: [] };
  if (declaration.port === undefined) return `${RUN_DECLARATION} names no port for the ${modality} target to listen on`;
  const routes = declaration.routes ?? [];
  return { target, command: ["sh", "-c", declaration.start], port: declaration.port, routes, ...(routes[0] === undefined ? {} : { path: routes[0] }) };
}
