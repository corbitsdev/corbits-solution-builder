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
import { ApiError, listWorkflowDeployments, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import {
  createArtifact,
  createProject as installerCreateProject,
  ensureSpecialistDeployment,
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
import { ARTIFACT_STAGE, type ArtifactKind } from "@solutions-builder/app/artifacts";
import { buildManifest, buildPackedEntries } from "./closure-pack.ts";
import { listProjectSummaries } from "../apps/web/src/project-list.ts";
import { readStageThread, sendStageMail } from "../apps/web/src/stage-mail.ts";

/**
 * `apps/web/src/stage-mail.ts`'s `readStageThread`/`sendStageMail` are built
 * on that module's own `createHubTransport()` (browser same-origin cookies,
 * relative `/api/...` paths -- see `apps/web/src/hub-origin.ts`), not this
 * script's bearer-token `Transport` against a spawned host. Rather than
 * hand-roll a second mailbox client, this shim makes THEIR transport work
 * here too: relative paths are rewritten onto the spawned host's origin,
 * with the same bearer/cookie headers `createTransport` above already
 * carries, before Node's `fetch` (which has no notion of "same-origin") ever
 * sees them. Absolute-URL calls elsewhere in this script (the provider
 * endpoint, the git push, etc.) pass through untouched.
 */
function installHubFetchShim(origin: string, hostToken: string, cookieJar: { value: string }): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== "string" || !input.startsWith("/")) return original(input, init);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${hostToken}`);
    if (cookieJar.value) headers.set("cookie", cookieJar.value);
    return original(`${origin}${input}`, { ...init, headers });
  }) as typeof fetch;
}

/** The kind stage 1's specialist writes its brief as (`ARTIFACT_STAGE`'s stage-1 producer kind, not the human-upload `source_material` kind). */
const STAGE1_ARTIFACT_KIND: ArtifactKind = "problem_brief";
if (ARTIFACT_STAGE[STAGE1_ARTIFACT_KIND] !== 1) {
  throw new Error(`ARTIFACT_STAGE[${STAGE1_ARTIFACT_KIND}] is ${ARTIFACT_STAGE[STAGE1_ARTIFACT_KIND]}, not stage 1`);
}

type RunEvent = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

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

/** Event types worth their whole body: failures and signal state, not just stepId/status. */
const FULL_BODY_EVENT_TYPES = new Set(["StepFailed", "RunFailed", "SignalReceived", "SignalAwaited"]);
const FULL_BODY_LIMIT = 600;

/**
 * For each event: `seq type stepId status/error`, reading whichever of those
 * the event carries -- except `StepFailed`/`RunFailed`/`SignalReceived`/
 * `SignalAwaited`, which print their full `JSON.stringify(body)` (truncated
 * to ~600 chars) since a bare stepId hides what actually went wrong.
 */
function eventLine(event: RunEvent): string {
  if (FULL_BODY_EVENT_TYPES.has(event.type)) {
    const body = JSON.stringify(event.body);
    return `${event.seq} ${event.type} ${body.length > FULL_BODY_LIMIT ? `${body.slice(0, FULL_BODY_LIMIT)}...` : body}`;
  }
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
 * The closure/git-push capabilities `ensureSpecialistDeployment` needs
 * (CL-8334), built the same way `scripts/pack-registry-asset.ts` builds
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
    installHubFetchShim(origin, host.token, cookieJar);

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
      const state = await installerInstall(transport);
      check("2. workspace tenant install (installer install path)", state.installed, state.detail);
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

    /** Dumps a specialist deployment's own agent run events on a poll timeout, per CL-8598's report contract. */
    const dumpDeploymentEvents = async (label: string, tenantId: string, deploymentId: string): Promise<void> => {
      const { events } = await readWorkflowRunEvents(transport, tenantId, deploymentId, deploymentId);
      dumpRunEvents(label, events as RunEvent[]);
    };

    /** Polls `listWorkflowDeployments` until `deploymentId` reports `status`, or times out. */
    const pollDeploymentStatus = async (
      tenantId: string,
      deploymentId: string,
      status: string,
      timeoutMs = 120_000,
    ): Promise<boolean> => {
      const found = await pollUntil(timeoutMs, 3_000, async () => {
        const deployments = await listWorkflowDeployments(transport, tenantId);
        const mine = deployments.find((entry) => entry.id === deploymentId);
        return mine?.status === status ? mine : null;
      });
      if (!found) await dumpDeploymentEvents(`deployment ${deploymentId}`, tenantId, deploymentId);
      return found !== null;
    };

    /**
     * Polls `readStageThread` (over `installHubFetchShim`'s rewritten
     * fetch) for the agent's `agentReplyCount + 1`th reply -- the specialist's
     * thread has no other participant, so every `author === "agent"` message
     * is one of its replies, oldest first.
     */
    const pollAgentReply = async (
      tenantId: string,
      address: string,
      agentReplyCount: number,
      timeoutMs = 180_000,
    ) =>
      pollUntil(timeoutMs, 3_000, async () => {
        const thread = await readStageThread(tenantId, [address]);
        const agentMessages = thread.filter((message) => message.author === "agent");
        return agentMessages.length > agentReplyCount ? agentMessages[agentMessages.length - 1]! : null;
      });

    // (5) Deploy the stage-1 specialist and wait for it to come up.
    const stage1 = await step("5. ensureSpecialistDeployment for stage 1", async () => {
      if (!workspace || !project || !sidecar) throw new Error("no workspace/project/sidecar to deploy against");
      const deployed = await ensureSpecialistDeployment(transport, sidecar, closure, gitPush, workspace.tenantId, project.id, 1, origin);
      check("5. ensureSpecialistDeployment for stage 1", true, JSON.stringify(deployed));
      return deployed;
    });

    await step("5. stage-1 deployment reaches status deployed", async () => {
      if (!workspace || !stage1) throw new Error("no stage-1 deployment to poll");
      const ok = await pollDeploymentStatus(workspace.tenantId, stage1.deploymentId, "deployed");
      check("5. stage-1 deployment reaches status deployed", ok, ok ? stage1.deploymentId : "timed out waiting for status deployed");
      if (!ok) throw new Error("stage-1 deployment never reached status deployed");
    });

    // (6) Mail the opening problem statement to the stage-1 specialist, then
    // poll the caller's own inbox for its reply.
    const OPENING_PROBLEM_STATEMENT = "Build a small internal tool that tracks team OKRs.";
    const firstReply = await step("6. mail the opening problem statement and poll for a reply", async () => {
      if (!workspace || !stage1) throw new Error("no workspace/stage-1 deployment to mail");
      await sendStageMail(workspace.tenantId, stage1.address, { body: OPENING_PROBLEM_STATEMENT, subject: "New project" });
      const reply = await pollAgentReply(workspace.tenantId, stage1.address, 0);
      if (!reply) await dumpDeploymentEvents(`deployment ${stage1.deploymentId}`, workspace.tenantId, stage1.deploymentId);
      check("6. mail the opening problem statement and poll for a reply", reply !== null, reply ? reply.id : "no reply within 180s");
      if (!reply) throw new Error(`no reply from ${stage1.address} within 180s`);
      return reply;
    });

    await step("6. the reply carries a non-empty body", async () => {
      if (!firstReply) throw new Error("no first reply to read");
      check("6. the reply carries a non-empty body", firstReply.body.trim().length > 0, firstReply.body.slice(0, 200));
    });

    // (7) Tighten the brief: a second round, same address, second reply.
    const secondReply = await step("7. mail a tightening round and poll for a second reply", async () => {
      if (!workspace || !stage1) throw new Error("no workspace/stage-1 deployment to mail");
      await sendStageMail(workspace.tenantId, stage1.address, { body: "Tighten the brief to one paragraph.", subject: "Re: New project" });
      const reply = await pollAgentReply(workspace.tenantId, stage1.address, 1);
      if (!reply) await dumpDeploymentEvents(`deployment ${stage1.deploymentId}`, workspace.tenantId, stage1.deploymentId);
      check("7. mail a tightening round and poll for a second reply", reply !== null, reply ? reply.id : "no second reply within 180s");
      if (!reply) throw new Error(`no second reply from ${stage1.address} within 180s`);
      return reply;
    });

    let approvedBrief = "";
    await step("7. the second reply carries a non-empty body", async () => {
      if (!secondReply) throw new Error("no second reply to read");
      approvedBrief = secondReply.body;
      check("7. the second reply carries a non-empty body", approvedBrief.trim().length > 0, approvedBrief.slice(0, 200));
    });

    // (8) "Approve" stage 1: the client writes the reply as the stage-1
    // artifact -- no gate signal, no admit chain (contract's "Deletions").
    await step("8. approve stage 1 by writing the artifact (createArtifact)", async () => {
      if (!workspace || !project) throw new Error("no workspace/project to write an artifact under");
      if (!approvedBrief.trim()) throw new Error("no approved brief text to write as the stage-1 artifact");
      const artifact = await createArtifact(transport, workspace.tenantId, {
        title: "Problem brief",
        content: approvedBrief,
        metadata: {
          sb: {
            projectId: project.id,
            kind: STAGE1_ARTIFACT_KIND,
            stage: 1,
            mediaType: "text/markdown",
            sourceVersionIds: [],
            provenance: { producer: "agent" },
          },
        },
      });
      check("8. approve stage 1 by writing the artifact (createArtifact)", true, `artifact ${artifact.id}`);
    });

    // (9) Deploy the stage-2 specialist, mail it the approved brief, poll for its reply.
    const stage2 = await step("9. ensureSpecialistDeployment for stage 2", async () => {
      if (!workspace || !project || !sidecar) throw new Error("no workspace/project/sidecar to deploy against");
      const deployed = await ensureSpecialistDeployment(transport, sidecar, closure, gitPush, workspace.tenantId, project.id, 2, origin);
      check("9. ensureSpecialistDeployment for stage 2", true, JSON.stringify(deployed));
      return deployed;
    });

    await step("9. stage-2 deployment reaches status deployed", async () => {
      if (!workspace || !stage2) throw new Error("no stage-2 deployment to poll");
      const ok = await pollDeploymentStatus(workspace.tenantId, stage2.deploymentId, "deployed");
      check("9. stage-2 deployment reaches status deployed", ok, ok ? stage2.deploymentId : "timed out waiting for status deployed");
      if (!ok) throw new Error("stage-2 deployment never reached status deployed");
    });

    await step("9. mail the approved brief to stage 2 and poll for a reply", async () => {
      if (!workspace || !stage2) throw new Error("no workspace/stage-2 deployment to mail");
      await sendStageMail(workspace.tenantId, stage2.address, { body: approvedBrief, subject: "Approved brief" });
      const reply = await pollAgentReply(workspace.tenantId, stage2.address, 0);
      if (!reply) await dumpDeploymentEvents(`deployment ${stage2.deploymentId}`, workspace.tenantId, stage2.deploymentId);
      check(
        "9. mail the approved brief to stage 2 and poll for a reply",
        reply !== null && reply.body.trim().length > 0,
        reply ? reply.id : "no reply within 180s",
      );
    });

    // (10) List artifacts via the artifacts client.
    await step("10. list artifacts via the artifacts client", async () => {
      if (!workspace || !project) throw new Error("no workspace/project to list artifacts under");
      const artifacts = await listArtifacts(transport, workspace.tenantId);
      const mine = artifacts.filter((entry) => (entry.metadata?.["sb"] as { projectId?: string } | undefined)?.projectId === project.id);
      check("10. list artifacts via the artifacts client", mine.length > 0, `${mine.length} artifact(s) for this project`);
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
