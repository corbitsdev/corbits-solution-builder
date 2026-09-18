/**
 * Client-driven end-to-end proof: signup to delivery, over hub routes only.
 *
 * Drives the product exactly as the browser does -- `packages/installer`,
 * `@intx/hub-client`, and the mounted corbitsdev routes reached through the
 * host's direct hub mount over an embedded hub (the same one `packages/embed-hub`
 * composes; booted here by spawning the app's own host, `apps/hub/src/server.ts`,
 * the way `scripts/hub-topology-smoke.ts` and `scripts/launch-smoke.ts` already
 * do). This script owns nothing in `apps/hub/src`; every product call below
 * goes through the hub's own paths -- the same seam the browser is limited to -- and the
 * two host routes it does call (`GET /api/status` for sidecar placement facts,
 * the outer-door bearer) are the same read-only boot facts the existing
 * smokes already reach for.
 *
 * Each step prints PASS/FAIL and continues past a failure, so a break in the
 * client-driven chain shows up as one failed step rather than an aborted run.
 *
 * Usage: bun --conditions intx-src scripts/e2e-client.ts
 *   SMOKE_PROVIDER_BASE_URL -- an OpenAI-compatible base URL to connect as
 *   the workspace's provider (default: an Ollama server the operator runs,
 *   serving gpt-oss:20b, qwen2.5:14b, llama3.2:3b).
 *   SMOKE_PROVIDER_API_KEY -- its API key (default "ollama", the placeholder
 *   Ollama's OpenAI-compatible endpoint accepts).
 *   ANTHROPIC_API_KEY -- if set (and SMOKE_PROVIDER_API_KEY is not), connects
 *   Anthropic directly instead of the OpenAI-compatible default.
 */
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, readWorkflowRunEvents, triggerWorkflowRun, type Transport } from "@intx/hub-client";
import {
  createProject as installerCreateProject,
  ensureLifecycleDeployment,
  install as installerInstall,
  listArtifacts,
  pushSourceTree,
  registerProviderModels,
  resolveWorkspace,
  upsertApiKeyProvider,
  type ClosureSource,
  type FetchLike,
  type ProjectPolicy,
  type SidecarCapability,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { buildManifest, buildPackedEntries } from "./closure-pack.ts";
import { openDecisionFor } from "../apps/web/src/decisions-fold.ts";
import { notifyDecisionOpen } from "../apps/web/src/decision-notify.ts";
import { listProjectSummaries } from "../apps/web/src/project-list.ts";
import { deliverGate, sendStageMail } from "../apps/web/src/run-signal.ts";
import { approveSignal } from "@solutions-builder/app/workflows/stage-loop";

/**
 * The chat section's fixed step ids -- unchanged across the whole rebuild
 * (`chat-section-contract.md`): the `onTrigger` container is `chat`, its
 * per-stage draft is `draft-<stage>`, the approve chain's top-level gate is
 * `gate-<stage>`, and the namer step (rendered once an offering exists) is
 * `name`. Hardcoded here rather than imported from the still-moving
 * `stage-loop.ts`/`project-lifecycle.ts` (owned by other lanes): only
 * `approveSignal`, the one export this lane depends on beyond these names.
 */
const CHAT_STEP_ID = "chat";
const NAME_STEP_ID = "name";
function draftStepId(stage: number): string {
  return `draft-${stage}`;
}
function gateStepId(stage: number): string {
  return `gate-${stage}`;
}

type RunEvent = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

/** Every `childRunId` an `onTrigger` container (or any step) spawned, in occurrence order. */
function childRunIds(events: readonly RunEvent[], stepId: string): string[] {
  return events
    .filter((event) => event.type === "ChildSpawned" && event.body["stepId"] === stepId)
    .map((event) => event.body["childRunId"] as string);
}

function stepCompleted(events: readonly RunEvent[], stepId: string): RunEvent | undefined {
  return events.find((event) => event.type === "StepCompleted" && event.body["stepId"] === stepId);
}

/**
 * Resolves a step output ref the same way `apps/web/src/stage-thread.ts`'s
 * `readRefOver` does: `inline:<json>` parsed directly, `blob:<sha>` fetched
 * through the deployment's blob route (no upstream `@intx/hub-client` op).
 * Reimplemented here rather than imported, since this lane owns nothing in
 * `apps/web/src`.
 */
async function resolveStepOutputRef(
  transport: Transport,
  tenantId: string,
  anchorRunId: string,
  runId: string,
  ref: string,
): Promise<unknown> {
  if (ref.startsWith("inline:")) return JSON.parse(ref.slice("inline:".length));
  const match = /^blob:(.+)$/.exec(ref);
  if (!match) throw new Error(`Unrecognized step output ref: ${ref}`);
  return transport.fetch("GET", `/api/tenants/${tenantId}/workflows/${anchorRunId}/runs/${runId}/blobs/${match[1]}`);
}

/** Polls `attempt` until it returns non-null, or `timeoutMs` elapses (then returns null). */
async function pollUntil<T>(timeoutMs: number, intervalMs: number, attempt: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await attempt();
    if (result !== null) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
let currentHost: Host | undefined;
let dumpedHostOnFirstFailure = false;

function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok && !dumpedHostOnFirstFailure && currentHost) {
    dumpedHostOnFirstFailure = true;
    dumpHostOutput(currentHost);
  }
  return ok;
}

/** For each event: `seq type stepId status/error`, reading whichever of those the event carries. */
function eventLine(event: RunEvent): string {
  const stepId = event.body["stepId"];
  const statusOrError = event.body["status"] ?? event.body["error"] ?? event.body["reason"] ?? event.body["message"];
  return [
    String(event.seq),
    event.type,
    stepId !== undefined ? String(stepId) : "-",
    statusOrError !== undefined ? String(statusOrError) : "",
  ]
    .join(" ")
    .trimEnd();
}

function dumpRunEvents(label: string, events: readonly RunEvent[]): void {
  console.log(`--- ${label} events ---`);
  for (const event of events) console.log(eventLine(event));
}

/** Last ~300 lines of the host's stdout/stderr, so a failure shows what the host actually did. */
function dumpHostOutput(host: Host): void {
  console.log("--- host stderr ---");
  console.log(host.stderrRing.get().join("\n"));
  console.log("--- host stdout ---");
  console.log(host.stdoutRing.get().join("\n"));
}

/** Runs one numbered step; a thrown error is a FAIL that does not abort the run. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? cause.message
        : typeof cause === "object"
          ? JSON.stringify(cause)
          : String(cause);
    check(name, false, detail);
    return null;
  }
}

const root = join(import.meta.dir, "..");
const ENTRY = join(root, "apps", "hub", "src", "server.ts");

/** A capped tail of lines, so a failure dump never grows unbounded. */
type RingBuffer = { push(chunk: string): void; get(): readonly string[] };
function makeRingBuffer(limit: number): RingBuffer {
  let lines: string[] = [];
  return {
    push(chunk: string) {
      lines.push(...chunk.split("\n"));
      if (lines.length > limit) lines = lines.slice(-limit);
    },
    get: () => lines,
  };
}

type Host = { process: Bun.Subprocess; token: string; port: number; stdoutRing: RingBuffer; stderrRing: RingBuffer };

/**
 * Boots the app's own host, which mounts `packages/embed-hub`'s app directly,
 * with no prefix. Stdout/stderr are drained into ring buffers (last ~300
 * lines each) for the whole life of the process, past the handshake, so a
 * later failure can show what the host actually did.
 */
async function startHost(dataDir: string): Promise<Host> {
  const child = Bun.spawn(["bun", "--conditions", "intx-src", ENTRY, "--port", "0"], {
    cwd: root,
    env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutRing = makeRingBuffer(300);
  const stderrRing = makeRingBuffer(300);

  const deadline = Date.now() + 150_000;
  let token = "";
  let port = 0;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (Date.now() < deadline && !token) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    buffer += text;
    stdoutRing.push(text);
    const match = /launch URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9-]+)/.exec(buffer);
    if (match) {
      port = Number(match[1]);
      token = match[2]!;
    }
  }
  if (!token) {
    reader.releaseLock();
    const stderr = await new Response(child.stderr).text().catch(() => "");
    throw new Error(`the host never reached its handshake - ${stderr.slice(-400) || buffer.slice(-200)}`);
  }

  // Keep draining both streams in the background for the rest of the run.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutRing.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // process exited / stream closed; nothing more to drain
    } finally {
      reader.releaseLock();
    }
  })();
  void (async () => {
    const stderrReader = child.stderr.getReader();
    const stderrDecoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrRing.push(stderrDecoder.decode(value, { stream: true }));
      }
    } catch {
      // process exited / stream closed; nothing more to drain
    } finally {
      stderrReader.releaseLock();
    }
  })();

  return { process: child, token, port, stdoutRing, stderrRing };
}

/**
 * A `Transport` against a real origin's hub mount: the outer-door bearer
 * plus whatever session cookie the last auth call set, so every call after
 * sign-up rides the same session a browser tab would keep in its cookie jar.
 */
function createTransport(origin: string, hostToken: string): { transport: Transport; cookieJar: { value: string } } {
  const cookieJar = { value: "" };
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = { authorization: `Bearer ${hostToken}`, origin };
      if (cookieJar.value) headers.cookie = cookieJar.value;
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${origin}${path}`, init);
      const setCookie = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const raw of setCookie) {
        const pair = raw.split(";")[0];
        if (pair) cookieJar.value = pair;
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const detail = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new ApiError(
          response.status,
          detail?.code ?? "unknown",
          `${method} ${path} -> HTTP ${response.status} ${detail?.code ?? "unknown"}: ${detail?.message ?? text.slice(0, 300)}`,
        );
      }
      return parsed as T;
    },
    subscribe(): () => void {
      throw new Error("subscribe() is not used by this smoke");
    },
  };
  return { transport, cookieJar };
}

async function authFetch(
  origin: string,
  hostToken: string,
  cookieJar: { value: string },
  path: string,
  body: unknown,
  method: "GET" | "POST" = "POST",
) {
  const response = await fetch(`${origin}/api/auth${path}`, {
    method,
    headers: {
      authorization: `Bearer ${hostToken}`,
      "content-type": "application/json",
      origin,
      ...(cookieJar.value ? { cookie: cookieJar.value } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const raw of setCookie) {
    const pair = raw.split(";")[0];
    if (pair) cookieJar.value = pair;
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { response, parsed };
}

const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
};

const DEFAULT_SMOKE_PROVIDER_BASE_URL = "https://thegreataxios-home-studio.tail87f5aa.ts.net/v1";

/**
 * Lists the models a live key can actually serve, by asking the provider
 * itself -- the same `GET {base}/v1/models` call `apps/web/src/provider-catalog.ts`'s
 * `connectApiKeyProvider` makes before writing anything.
 */
async function discoverModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`the provider rejected this key (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (body?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) throw new Error("this key works, but the provider did not list any model");
  return ids;
}

const PROJECT_POLICY: ProjectPolicy = {
  costTolerancePercent: 20,
  costToleranceAbsolute: 500,
  audiences: [],
  audienceQuorum: 1,
  allowExternalProviders: false,
};

/**
 * The closure/git-push capabilities `installerInstall`/`ensureLifecycleDeployment`
 * need (CL-8334), built the same way `scripts/pack-registry-asset.ts` builds
 * them for its own embedded-hub install call: the manifest in-memory from
 * the packer, and the push over the spawned host's real hub-mounted git
 * smart-HTTP route -- unlike that script, this one talks to a real listening
 * socket, so the push rides the plain global `fetch` `pushSourceTree`
 * defaults to, no `app.fetch` adapter needed.
 *
 * `apps/hub/src/server.ts`'s outer door gates every `/api/*` request on
 * either an `Authorization: Bearer <hostToken>` matching the host's own
 * launch token, or the `solutions_builder_session` cookie a browser tab
 * gets (and then carries automatically) from visiting the handshake URL --
 * that cookie's value is the same host token, verbatim. The git push's own
 * `Authorization` header already carries the *minted git token* the
 * vendored smart-HTTP route expects, which collides with the outer door's
 * bearer scheme on the same header, so the outer door can only be
 * satisfied here the way a browser satisfies it: by attaching that session
 * cookie. A plain Node `fetch` does not carry cookies the way a browser tab
 * does, and this script never loads the handshake page, so it is set
 * explicitly from the host token this script already holds.
 */
async function closureAndPush(origin: string, hostToken: string): Promise<{ closure: ClosureSource; gitPush: WorkflowGitPush }> {
  const entries = await buildPackedEntries();
  const manifest = buildManifest("scripts/e2e-client.ts", entries);
  const byFilename = new Map(entries.map((entry) => [entry.filename, entry.bytes]));
  const closure: ClosureSource = {
    manifest,
    fetchTarball: async (filename) => {
      const bytes = byFilename.get(filename);
      if (bytes === undefined) throw new Error(`no packed entry for ${filename}`);
      return bytes;
    },
  };
  const fetchImpl: FetchLike = (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), cookie: `solutions_builder_session=${hostToken}` },
    });
  const gitPush: WorkflowGitPush = async ({ scope, assetKind, assetName, token, tree, message }) => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-client-push-"));
    try {
      const url = `${origin}/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`;
      return await pushSourceTree({ url, token, tree, message, fsBackend: { fs, dir }, fetchImpl });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return { closure, gitPush };
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "sb-e2e-"));
  let host: Host | undefined;
  try {
    host = (await step("boot: embedded hub reaches its handshake", () => startHost(dataDir))) ?? undefined;
    if (!host) {
      console.log("\nCannot continue without a booted host.");
      process.exitCode = 1;
      return;
    }
    check("boot: embedded hub reaches its handshake", true);
    currentHost = host;
    const origin = `http://127.0.0.1:${host.port}`;
    const { transport, cookieJar } = createTransport(origin, host.token);

    // (1) Sign up / session.
    const email = `owner+${Date.now()}@e2e-client-proof.invalid`;
    const password = "Sm0ke-Test-Pass-2026!";
    await step("1. sign up over /api/auth/sign-up/email", async () => {
      const { response, parsed } = await authFetch(origin, host!.token, cookieJar, "/sign-up/email", {
        email,
        password,
        name: "E2E Client Proof",
      });
      const user = (parsed as { user?: { id?: string; email?: string } } | undefined)?.user;
      check(
        "1. sign up over /api/auth/sign-up/email",
        response.ok && typeof user?.id === "string",
        response.ok ? "" : `HTTP ${response.status} ${JSON.stringify(parsed).slice(0, 200)}`,
      );
      const session = await authFetch(origin, host!.token, cookieJar, "/get-session", undefined, "GET");
      const sessionUser = (session.parsed as { user?: { email?: string } } | undefined)?.user;
      check("1. the session carries the signed-up user", sessionUser?.email === email, JSON.stringify(session.parsed).slice(0, 200));
    });

    // Sidecar placement facts, the same two the host's own `GET /status`
    // already names for the hub mount (`apps/hub/src/hub-mount.ts`).
    const sidecar = await step("boot: sidecar placement facts from GET /api/status", async () => {
      const response = await fetch(`${origin}/api/status`, { headers: { authorization: `Bearer ${host!.token}` } });
      const body = (await response.json()) as { canPlaceSidecars?: boolean; sidecarFingerprint?: string | null };
      const ok = response.ok && body.canPlaceSidecars === true && typeof body.sidecarFingerprint === "string";
      check("boot: sidecar placement facts from GET /api/status", ok, JSON.stringify(body).slice(0, 200));
      if (!ok) throw new Error("no sidecar capability to deploy against");
      return { canPlaceSidecars: true } satisfies SidecarCapability;
    });

    const { closure, gitPush } = await closureAndPush(origin, host.token);

    // (2) Workspace tenant install.
    const workspace = await step("2. workspace tenant install (installer install path)", async () => {
      if (!sidecar) throw new Error("no sidecar capability from the boot step");
      const state = await installerInstall(transport, sidecar, closure, gitPush);
      check(
        "2. workspace tenant install (installer install path)",
        state.missing.length === 0 && state.stale.length === 0,
        state.detail,
      );
      const resolved = await resolveWorkspace(transport);
      if (!resolved) throw new Error("the hub installed the workspace but does not resolve it back");
      check("2. the workspace resolves back through the hub", true, `tenant ${resolved.tenantId}`);
      return resolved;
    });

    // (3) Connect an API-key provider. Prefers Anthropic directly when only
    // ANTHROPIC_API_KEY is set; otherwise connects the OpenAI-compatible
    // endpoint at SMOKE_PROVIDER_BASE_URL (an Ollama server by default) with
    // SMOKE_PROVIDER_API_KEY (default "ollama"), discovering its servable
    // models live the same way `connectApiKeyProvider` does.
    const anthropicKey = process.env.SMOKE_PROVIDER_API_KEY ? undefined : process.env.ANTHROPIC_API_KEY;
    if (workspace) {
      await step("3. connect an API-key provider", async () => {
        if (anthropicKey) {
          const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
            providerId: "anthropic",
            label: "Anthropic",
            plugin: "anthropic",
            baseURL: DEFAULT_BASE_URL.anthropic!,
            apiKey: anthropicKey,
          });
          // Model discovery calls the vendor's own API (the "inference step");
          // this smoke skips it and records the canonical name it already knows.
          await registerProviderModels(transport, workspace.tenantId, {
            modelProviderId,
            canonicalNames: ["claude-3-5-sonnet-20241022"],
          });
          check("3. connect an API-key provider", true, `model provider ${modelProviderId} (anthropic)`);
          return;
        }

        const baseURL = (process.env.SMOKE_PROVIDER_BASE_URL ?? DEFAULT_SMOKE_PROVIDER_BASE_URL).replace(/\/+$/, "");
        const apiKey = process.env.SMOKE_PROVIDER_API_KEY ?? "ollama";
        const canonicalNames = await discoverModels(baseURL, apiKey);
        const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
          providerId: "smoke-openai-compatible",
          label: "Smoke OpenAI-compatible",
          plugin: "openai-compatible",
          baseURL,
          apiKey,
        });
        await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames });
        check(
          "3. connect an API-key provider",
          true,
          `model provider ${modelProviderId} (openai-compatible, ${canonicalNames.length} model(s) at ${baseURL})`,
        );
      });
    }

    // (4) Create a project.
    const project = await step("4. create a project (installer project-tenant)", async () => {
      if (!workspace) throw new Error("no workspace to open a project under");
      const { project: created } = await installerCreateProject(transport, workspace.tenantId, {
        title: "E2E Client Proof Project",
        slug: `e2e-client-proof-${Date.now()}`,
        policy: PROJECT_POLICY,
      });
      check("4. create a project (installer project-tenant)", true, `project ${created.id}`);
      return created;
    });

    const deployment = await step("4. ensureLifecycleDeployment places the project's run", async () => {
      if (!workspace || !project || !sidecar) throw new Error("no project/workspace/sidecar to deploy against");
      const deployed = await ensureLifecycleDeployment(transport, sidecar, closure, gitPush, workspace.tenantId, project.id);
      const ok = deployed.status === "deployed" || deployed.status === "current";
      check(
        "4. ensureLifecycleDeployment places the project's run",
        ok,
        JSON.stringify(deployed).slice(0, 200),
      );
      if (!ok || !("deploymentId" in deployed)) throw new Error(`deployment did not place a run: ${JSON.stringify(deployed)}`);
      return deployed;
    });

    // (4b) Fire the deployment's top-level run once, the way `apps/web/src/client.ts`'s
    // `createProject` does immediately after `ensureLifecycleDeployment` -- the host no
    // longer launches the lifecycle, so nothing else starts this run.
    await step("4b. trigger the deployment's top-level run", async () => {
      if (!workspace || !deployment || !("deploymentId" in deployment)) throw new Error("no deployment to trigger");
      await triggerWorkflowRun(transport, workspace.tenantId, deployment.deploymentId, {
        content: JSON.stringify({ projectId: project!.id, problemStatement: "Build a small internal tool that tracks team OKRs." }),
      });
      check("4b. trigger the deployment's top-level run", true);
    });

    // (5) List projects via apps/web/src/project-list.ts's helper.
    await step("5. list projects via project-list.ts's listProjectSummaries", async () => {
      const summaries = await listProjectSummaries(transport);
      const found = project ? summaries.find((entry) => entry.id === project.id) : undefined;
      check(
        "5. list projects via project-list.ts's listProjectSummaries",
        found !== undefined,
        `${summaries.length} project(s); mine ${found ? "present" : "missing"}`,
      );
    });

    const anchorRunId = deployment && "deploymentId" in deployment ? deployment.deploymentId : null;

    /** Reads the anchor's own event log (its `chat` container's occurrences are `ChildSpawned` there, not on the child). */
    const readAnchorEvents = async (): Promise<RunEvent[]> => {
      if (!workspace || !anchorRunId) throw new Error("no anchor run to read events from");
      const { events } = await readWorkflowRunEvents(transport, workspace.tenantId, anchorRunId, anchorRunId);
      return events as RunEvent[];
    };

    /**
     * On a poll timeout for a chat-occurrence step (`draft-1`, `draft-2`,
     * `gate-N`...), dumps that run's own events, plus the anchor run's
     * events when the polled run is not the anchor itself.
     */
    const dumpTimeoutEvents = async (stepId: string, runId: string): Promise<void> => {
      if (!workspace || !anchorRunId) return;
      const { events } = await readWorkflowRunEvents(transport, workspace.tenantId, anchorRunId, runId);
      dumpRunEvents(`${stepId} in ${runId}`, events as RunEvent[]);
      if (runId !== anchorRunId) dumpRunEvents(`anchor ${anchorRunId}`, await readAnchorEvents());
    };

    /** Polls a chat occurrence's own run until `stepId` completes, then resolves its output ref. */
    const pollDraft = async (chatRunId: string, stepId: string, timeoutMs = 180_000): Promise<unknown> => {
      if (!workspace || !anchorRunId) throw new Error("no anchor/workspace to poll a draft under");
      const completed = await pollUntil(timeoutMs, 3_000, async () => {
        const { events } = await readWorkflowRunEvents(transport, workspace.tenantId, anchorRunId, chatRunId);
        return stepCompleted(events as RunEvent[], stepId) ?? null;
      });
      if (!completed) {
        await dumpTimeoutEvents(stepId, chatRunId);
        throw new Error(`${stepId} in ${chatRunId} never completed within ${String(timeoutMs)}ms`);
      }
      const ref = (completed.body["output"] as { ref?: string } | undefined)?.ref;
      if (typeof ref !== "string") throw new Error(`${stepId}'s StepCompleted carried no output ref`);
      return resolveStepOutputRef(transport, workspace.tenantId, anchorRunId, chatRunId, ref);
    };

    // (5) The opening mail fired in (4b) drives the `name` step and the
    // `chat` section's first occurrence directly off the run's own firing
    // trigger -- nothing more to send.
    await step("5. anchor shows the name step and the chat section started", async () => {
      const events = await pollUntil(120_000, 2_000, async () => {
        const current = await readAnchorEvents();
        const nameShown = current.some((event) => event.body["stepId"] === NAME_STEP_ID);
        const chatStarted = childRunIds(current, CHAT_STEP_ID).length > 0;
        return nameShown && chatStarted ? current : null;
      });
      check(
        "5. anchor shows the name step and the chat section started",
        events !== null,
        events === null ? "timed out waiting for name/chat" : `${events.length} anchor event(s)`,
      );
      if (!events) throw new Error("the anchor never showed the name step and a chat occurrence");
    });

    // (6) The chat section's first occurrence (`chat__0`) is the opening
    // mail's own reply: find its run id off the anchor's `ChildSpawned`,
    // then poll it for `draft-1`'s completion and assert a real reply.
    const chatRunId0 = await step("6. find the chat body's first occurrence run id", async () => {
      const events = await readAnchorEvents();
      const [runId] = childRunIds(events, CHAT_STEP_ID);
      check("6. find the chat body's first occurrence run id", typeof runId === "string", runId ?? "no ChildSpawned for chat");
      if (typeof runId !== "string") throw new Error("no chat occurrence run id on the anchor's events");
      return runId;
    });

    await step("6. draft-1 completes with a non-empty reply", async () => {
      if (!chatRunId0) throw new Error("no first chat occurrence to poll");
      const output = (await pollDraft(chatRunId0, draftStepId(1))) as { reply?: unknown };
      const ok = typeof output.reply === "string" && output.reply.trim().length > 0;
      check("6. draft-1 completes with a non-empty reply", ok, JSON.stringify(output).slice(0, 200));
    });

    // (7) A stage-1 round is mail to the anchor, same as the opening: it
    // drives the chat section's SECOND occurrence (`chat__1`), a fresh
    // child run with its own `draft-1`.
    await step("7. send a stage-1 round as mail", async () => {
      if (!workspace || !anchorRunId) throw new Error("no project/anchor run to mail");
      await sendStageMail(
        { tenantId: workspace.tenantId, anchorRunId },
        { stage: 1, command: "stage.draft", runId: anchorRunId, message: "Tighten the brief to one paragraph." },
        transport,
      );
      check("7. send a stage-1 round as mail", true);
    });

    const chatRunId1 = await step("7. find the chat body's second occurrence run id", async () => {
      const events = await pollUntil(60_000, 2_000, async () => {
        const current = await readAnchorEvents();
        const runIds = childRunIds(current, CHAT_STEP_ID);
        return runIds.length >= 2 ? runIds : null;
      });
      check("7. find the chat body's second occurrence run id", events !== null, events ? events[1]! : "second occurrence never spawned");
      if (!events) throw new Error("the anchor never spawned a second chat occurrence");
      return events[1]!;
    });

    await step("7. the stage-1 round's draft-1 completes with a reply", async () => {
      if (!chatRunId1) throw new Error("no second chat occurrence to poll");
      const output = (await pollDraft(chatRunId1, draftStepId(1))) as { reply?: unknown };
      const ok = typeof output.reply === "string" && output.reply.trim().length > 0;
      check("7. the stage-1 round's draft-1 completes with a reply", ok, JSON.stringify(output).slice(0, 200));
    });

    // (8) Write the mailbox item the same way the client does, while stage
    // 1's gate is still open -- there is no host-side writer any more (the
    // announcement stub in `apps/hub/src/decisions.ts` is gone) -- then
    // confirm the inbox has it.
    await step("8. mailbox inbox carries an item for the open gate", async () => {
      if (!workspace || !anchorRunId) throw new Error("no workspace/anchor run to notify for");
      // The anchor's deployment lives in the workspace tenant (steps 5-7 read it
      // there too), not the project's own tenant -- `openDecisionFor`'s
      // "projectId" is really the scope its `GET /api/tenants/<scope>/...` calls
      // address, so that scope has to be `workspace.tenantId` here.
      const decision = await openDecisionFor(workspace.tenantId, anchorRunId, transport);
      if (decision) await notifyDecisionOpen(decision, transport);
      const response = await fetch(`${origin}/api/me/inbox`, {
        headers: { authorization: `Bearer ${host!.token}`, cookie: cookieJar.value },
      });
      if (!response.ok) throw new Error(`GET /api/me/inbox -> HTTP ${response.status}`);
      const body = (await response.json()) as { messages?: unknown[] };
      const ok = Array.isArray(body.messages) && body.messages.length > 0;
      check("8. mailbox inbox carries an item for the open gate", ok, `${body.messages?.length ?? 0} message(s)`);
    });

    // (8) Approve stage 1 on the flat top-level gate chain: a signal, not a
    // mail, straight on `approveSignal(1)` -- there is no admit/submit
    // prerequisite left in the workflow (contract's "Deletions").
    await step("8. approve stage 1 (deliverGate) and poll gate-1 completed", async () => {
      if (!workspace || !anchorRunId) throw new Error("no project/anchor run to signal");
      await deliverGate(
        { tenantId: workspace.tenantId, anchorRunId },
        1,
        null,
        { command: "stage.approve", runId: anchorRunId },
        transport,
      );
      const events = await pollUntil(60_000, 2_000, async () => {
        const current = await readAnchorEvents();
        return stepCompleted(current, gateStepId(1)) ?? null;
      });
      if (!events && anchorRunId) await dumpTimeoutEvents(gateStepId(1), anchorRunId);
      check(
        "8. approve stage 1 (deliverGate) and poll gate-1 completed",
        events !== null,
        events ? `${approveSignal(1)} -> gate-1 completed` : "gate-1 never completed",
      );
    });

    // (9) A stage-2 mail drives the chat section's THIRD occurrence
    // (`chat__2`), routed by `route`'s own `at.2` to `draft-2`.
    await step("9. send a stage-2 mail", async () => {
      if (!workspace || !anchorRunId) throw new Error("no project/anchor run to mail");
      await sendStageMail(
        { tenantId: workspace.tenantId, anchorRunId },
        { stage: 2, command: "stage.draft", runId: anchorRunId, message: "Draft the stage 2 plan." },
        transport,
      );
      check("9. send a stage-2 mail", true);
    });

    const chatRunId2 = await step("9. find the chat body's third occurrence run id", async () => {
      const events = await pollUntil(60_000, 2_000, async () => {
        const current = await readAnchorEvents();
        const runIds = childRunIds(current, CHAT_STEP_ID);
        return runIds.length >= 3 ? runIds : null;
      });
      check("9. find the chat body's third occurrence run id", events !== null, events ? events[2]! : "third occurrence never spawned");
      if (!events) throw new Error("the anchor never spawned a third chat occurrence");
      return events[2]!;
    });

    await step("9. the stage-2 mail's draft-2 completes with a reply", async () => {
      if (!chatRunId2) throw new Error("no third chat occurrence to poll");
      const output = (await pollDraft(chatRunId2, draftStepId(2))) as { reply?: unknown };
      const ok = typeof output.reply === "string" && output.reply.trim().length > 0;
      check("9. the stage-2 mail's draft-2 completes with a reply", ok, JSON.stringify(output).slice(0, 200));
    });

    // (10) List artifacts via the artifacts client.
    await step("10. list artifacts via the artifacts client", async () => {
      if (!project) throw new Error("no project to list artifacts under");
      const artifacts = await listArtifacts(transport, project.id);
      check("10. list artifacts via the artifacts client", true, `${artifacts.length} artifact(s)`);
    });

  } finally {
    host?.process.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nClient-driven end-to-end proof: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log(`First failure: ${failed[0]!.name} - ${failed[0]!.detail}`);
  if (currentHost) dumpHostOutput(currentHost);
}
process.exit(failed.length === 0 ? 0 : 1);
