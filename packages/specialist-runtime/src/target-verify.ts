/**
 * `web`, `api` and `cli` target verification — CL-8863.
 *
 * `targets.ts` describes what these checks do (`GUIDANCE`). Their callers
 * package a build attempt (`verify.ts`): each target is started from the
 * attempt directory with the start command, port and routes named for it —
 * by the person, by the build engineer, or by the attempt's own run
 * declaration (`run-declared.ts`) — and the resulting `TargetVerification`
 * is recorded on the delivery manifest, where stage 9 and the person read
 * it. What a target starts may reach this machine's network and nothing
 * else, where the platform can confine it (`localNetworkOnly`).
 *
 * The `web` and `api` checks are HTTP-only. There is no headless browser in this repo (no
 * playwright, no puppeteer) — `verifyWebTarget` fetches pages over plain
 * HTTP and never renders anything, and says so in its transcript rather
 * than implying a browser check that is not there.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { inheritedEnvironment, localNetworkOnly, networkLine } from "./host-environment.js";
import type { TargetVerification } from "./targets.js";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const PORT_POLL_INTERVAL_MS = 200;
const DEFAULT_ROUTE_TIMEOUT_MS = 5_000;

export interface ProcessTarget {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly port: number;
  /** Set on top of the allowlisted environment (`host-environment.ts`); the host's own is never passed through. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long to wait for the port to open before giving up. Defaults to 15s. */
  readonly startTimeoutMs?: number;
}

export interface ApiVerificationInput extends ProcessTarget {
  /** Paths to GET once the port is open, e.g. `["/", "/health"]`. Never empty. */
  readonly routes: readonly string[];
}

export interface WebVerificationInput extends ProcessTarget {
  /** The page to load. Defaults to `"/"`. */
  readonly path?: string;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      // Any response at all — including a 404 or 500 — means something is
      // listening. What that means is for the caller's route checks to say.
      void response.body?.cancel();
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS));
    }
  }
}

/**
 * Starts a target as the leader of its own process group, so ending it
 * ends what it started too: a start command given as one shell string runs
 * through `sh -c`, and ending only the shell left the server it started
 * listening on the port, in the attempt directory. On Windows there are no
 * groups; the tree is taken down by pid.
 */
type Started = { child: ChildProcess; exited: Promise<void>; confined: boolean };

function startTarget(input: Omit<ProcessTarget, "port">, output?: Buffer[]): Started {
  const { command: confinedCommand, confined } = localNetworkOnly(input.command);
  const [command, ...rest] = confinedCommand;
  const child = spawn(command ?? "", rest, {
    cwd: input.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Never the host's own environment: see host-environment.ts.
    env: { ...inheritedEnvironment(), ...input.env },
    detached: process.platform !== "win32",
  });
  // Kept when asked for, else drained and discarded: a target that fills its pipe would otherwise stall.
  if (output) {
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  } else {
    child.stdout?.resume();
    child.stderr?.resume();
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      output?.push(Buffer.from(`${error.message}\n`));
      resolve();
    });
  });
  return { child, exited, confined };
}

async function killProcess(target: { child: ChildProcess; exited: Promise<void> }): Promise<void> {
  const { child, exited } = target;
  if (child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).once("error", () => child.kill("SIGKILL"));
    await exited;
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  const timer = setTimeout(() => signalGroup("SIGKILL"), 2_000);
  await exited;
  clearTimeout(timer);
  // The leader is gone; what it started may not be. One more pass, then
  // the hard one after the same grace, so a backgrounded server never
  // outlives its probe.
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), 2_000).unref();
}

/**
 * Starts `input.command`, waits for `input.port` to accept connections, then
 * GETs each of `input.routes` and records its status and body length. The
 * process is killed on the way out whether verification succeeded or not.
 * Never fabricates a route's result — a route that could not be reached is
 * recorded as such, not silently dropped.
 */
export async function verifyApiTarget(target: string, input: ApiVerificationInput): Promise<TargetVerification> {
  if (input.routes.length === 0) {
    return {
      target,
      modality: "api",
      exercised: false,
      realInputFed: false,
      ranSuccessfully: false,
      producedOutput: false,
      transcript: "no routes were declared to check — nothing to verify against a running process.",
    };
  }
  const child = startTarget(input);
  try {
    const opened = await waitForPort(input.port, input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    if (!opened) {
      return {
        target,
        modality: "api",
        exercised: true,
        realInputFed: false,
        ranSuccessfully: false,
        producedOutput: false,
        transcript: `$ ${input.command.join(" ")}\n\n${networkLine(child.confined)}\n\nport ${input.port} never accepted a connection within ${input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms.`,
      };
    }
    const results: { route: string; status: number | "unreachable"; bodyLength: number }[] = [];
    for (const route of input.routes) {
      try {
        const response = await fetch(`http://127.0.0.1:${input.port}${route}`, {
          signal: AbortSignal.timeout(DEFAULT_ROUTE_TIMEOUT_MS),
        });
        const body = await response.text();
        results.push({ route, status: response.status, bodyLength: body.length });
      } catch (error) {
        results.push({ route, status: "unreachable", bodyLength: 0 });
        void error;
      }
    }
    const ranSuccessfully = results.every((r) => r.status !== "unreachable");
    const producedOutput = results.some((r) => typeof r.status === "number" && r.status < 500 && r.bodyLength > 0);
    const transcript = [
      `$ ${input.command.join(" ")}`,
      networkLine(child.confined),
      `port ${input.port} opened.`,
      results.map((r) => `GET ${r.route} -> ${r.status}${typeof r.status === "number" ? ` (${r.bodyLength} bytes)` : ""}`).join("\n"),
    ].join("\n\n");
    return { target, modality: "api", exercised: true, realInputFed: false, ranSuccessfully, producedOutput, transcript };
  } finally {
    await killProcess(child);
  }
}

const ASSET_PATTERN = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+)["']/i;

function resolveAsset(base: string, assetPath: string): string | null {
  try {
    return new URL(assetPath, base).toString();
  } catch {
    return null;
  }
}

/**
 * Starts `input.command`, waits for the port, then fetches `input.path`
 * (default `/`) over plain HTTP and checks for a 200 with an HTML body,
 * plus one referenced script or stylesheet asset also fetched and checked.
 * This is an HTTP-response check, never a browser: no DOM is built, no
 * JavaScript runs, and no console is observed — the transcript says so.
 */
export async function verifyWebTarget(target: string, input: WebVerificationInput): Promise<TargetVerification> {
  const path = input.path ?? "/";
  const child = startTarget(input);
  try {
    const opened = await waitForPort(input.port, input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    if (!opened) {
      return {
        target,
        modality: "web",
        exercised: true,
        realInputFed: false,
        ranSuccessfully: false,
        producedOutput: false,
        transcript: `$ ${input.command.join(" ")}\n\n${networkLine(child.confined)}\n\nport ${input.port} never accepted a connection within ${input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms.`,
      };
    }
    const pageUrl = `http://127.0.0.1:${input.port}${path}`;
    let pageStatus: number | "unreachable" = "unreachable";
    let html = "";
    try {
      const response = await fetch(pageUrl, { signal: AbortSignal.timeout(DEFAULT_ROUTE_TIMEOUT_MS) });
      pageStatus = response.status;
      html = await response.text();
    } catch {
      // pageStatus stays "unreachable"
    }
    const pageOk = pageStatus === 200 && /<html/i.test(html);
    let assetLine = "no script or stylesheet reference found in the page to check.";
    const assetMatch = ASSET_PATTERN.exec(html);
    if (assetMatch) {
      const assetUrl = resolveAsset(pageUrl, assetMatch[1]!);
      if (assetUrl) {
        try {
          const assetResponse = await fetch(assetUrl, { signal: AbortSignal.timeout(DEFAULT_ROUTE_TIMEOUT_MS) });
          void assetResponse.body?.cancel();
          assetLine = `GET ${assetUrl} -> ${assetResponse.status}`;
        } catch {
          assetLine = `GET ${assetUrl} -> unreachable`;
        }
      }
    }
    const ranSuccessfully = pageOk;
    const producedOutput = html.trim().length > 0;
    const transcript = [
      `$ ${input.command.join(" ")}`,
      networkLine(child.confined),
      `port ${input.port} opened.`,
      `GET ${pageUrl} -> ${pageStatus}${html.length > 0 ? ` (${html.length} bytes)` : ""}`,
      assetLine,
      "This is an HTTP-response check, not a browser: no DOM was built, no JavaScript ran, and no console errors were observed. This repo has no headless browser (no playwright, no puppeteer). No scripted acceptance-criteria flow was run.",
    ].join("\n\n");
    return { target, modality: "web", exercised: true, realInputFed: false, ranSuccessfully, producedOutput, transcript };
  } finally {
    await killProcess(child);
  }
}

const OUTPUT_KEEP = 4_000;

export type BoundedRun = {
  readonly command: string;
  readonly exitStatus: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly confined: boolean;
  /** Its stdout and stderr as they came, the last `OUTPUT_KEEP` characters. */
  readonly output: string;
};

/**
 * Runs `command` until it ends or `timeoutMs` passes, whichever is first,
 * and returns how it ended with its output's tail. Whatever it left running
 * in its process group is ended either way.
 */
export async function runBounded(input: { command: readonly string[]; cwd: string; timeoutMs: number; env?: Readonly<Record<string, string>> }): Promise<BoundedRun> {
  const output: Buffer[] = [];
  const started = startTarget(input, output);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcess(started);
  }, input.timeoutMs);
  await started.exited;
  clearTimeout(timer);
  await killProcess(started);
  return {
    command: input.command.join(" "),
    exitStatus: started.child.exitCode,
    signal: started.child.signalCode,
    timedOut,
    confined: started.confined,
    output: Buffer.concat(output).toString("utf8").slice(-OUTPUT_KEEP),
  };
}

/** How a bounded run ended, in one line. */
export function describeRun(run: BoundedRun, timeoutMs: number): string {
  if (run.timedOut) return `did not end within ${String(timeoutMs / 1000)}s and was stopped`;
  return run.exitStatus !== null ? `exited ${String(run.exitStatus)}` : `ended by ${run.signal ?? "an unknown cause"}`;
}

/**
 * Runs a command-line target's smoke command (its `--help`, unless it
 * declares another) and records how it ended and what it printed. Passes
 * only on exit status 0 within the time allowed; no requirement's input is
 * fed to it.
 */
export async function verifyCliTarget(target: string, input: { command: readonly string[]; cwd: string; timeoutMs: number }): Promise<TargetVerification> {
  const run = await runBounded(input);
  const transcript = [`$ ${run.command}`, networkLine(run.confined), describeRun(run, input.timeoutMs), run.output.trim() || "(no output)"].join("\n\n");
  return {
    target,
    modality: "cli",
    exercised: true,
    realInputFed: false,
    ranSuccessfully: !run.timedOut && run.exitStatus === 0,
    producedOutput: run.output.trim().length > 0,
    transcript,
  };
}
