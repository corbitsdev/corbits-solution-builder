/**
 * `web` and `api` target verification — CL-8863.
 *
 * `targets.ts` describes what these checks do (`GUIDANCE.web`/`GUIDANCE.api`)
 * but nothing in this repo calls them: `apps/hub/src/completion-judge.ts`,
 * the file that used to run `cli` verification the same way, was deleted in
 * commit ebf6e896 (CL-8340) when stage 8 moved to a mail-fed agent (the
 * `build-engineer` role in `kit.ts`) that runs its own shell commands and
 * self-reports, rather than a bounded bridge process this host drove. No
 * replacement call site for *any* modality's verification exists today —
 * this module is a pure implementation of the `web`/`api` checks, written
 * ahead of that wiring so it does not block on it. It needs a caller that:
 *   1. Starts the deliverable the same way stage 8's evidence says it runs
 *      (a command and a port), most likely from the `build_evidence` the
 *      build engineer already reports, or from the frozen `StackRecord`.
 *   2. Feeds `api` its declared routes — there is nowhere today that a
 *      route list is recorded; the acceptance criteria or the requirements
 *      block is the likely source, not invented here.
 *   3. Puts the resulting `TargetVerification` somewhere a human or a judge
 *      reads it — the old `CompletionVerdict` shape (deleted) or whatever
 *      stage 8's evidence review adopts next.
 *
 * Both checks are HTTP-only. There is no headless browser in this repo (no
 * playwright, no puppeteer) — `verifyWebTarget` fetches pages over plain
 * HTTP and never renders anything, and says so in its transcript rather
 * than implying a browser check that is not there.
 */
import type { TargetVerification } from "./targets.js";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const PORT_POLL_INTERVAL_MS = 200;
const DEFAULT_ROUTE_TIMEOUT_MS = 5_000;

export interface ProcessTarget {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly port: number;
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

async function killProcess(child: Bun.Subprocess): Promise<void> {
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await child.exited;
  clearTimeout(timer);
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
  const child = Bun.spawn([...input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...input.env },
  });
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
        transcript: `$ ${input.command.join(" ")}\n\nport ${input.port} never accepted a connection within ${input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms.`,
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
  const child = Bun.spawn([...input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...input.env },
  });
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
        transcript: `$ ${input.command.join(" ")}\n\nport ${input.port} never accepted a connection within ${input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS}ms.`,
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
