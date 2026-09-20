/**
 * CL-8719 real proof: a stage-1 specialist writes its own draft as a real
 * `@corbits/artifacts` artifact, through the run-scoped `mountWorkflowArtifacts`
 * mount and the `@corbits/artifacts/sidecar-bundle` agent tool bundle -- no
 * fixture, no stand-in for the mount or the credential path.
 *
 * Boots the real embedded hub (`apps/hub/src/server.ts`, exactly as
 * `scripts/e2e-client.ts` does), signs up, connects a live OpenAI-compatible
 * provider, creates a project, deploys the stage-1 specialist (which now
 * mints and registers the `hub` credential bearer -- CL-8719's
 * `ensureWorkflowArtifactsCredential`), mails it an opening problem
 * statement, waits for its reply, then reads the tenant's artifacts back
 * through the BROWSER surface (`@solutions-builder/installer`'s
 * `listArtifacts`) and asserts the specialist's own tool call produced one:
 * `source.origin === "workflow"`, `source.runId` naming this deployment's
 * anchor run, and a non-null `contentSha256`.
 *
 * KNOWN GAP (documented in the CL-8719 report, not re-derived here): at the
 * pinned `@corbits/artifacts` commit (0190e6c), `mountWorkflowArtifacts`'s
 * create/revise bodies and the sidecar-bundle's tool schemas carry no
 * `metadata` field at all -- a specialist's `artifact_create`/`artifact_write`
 * call cannot stamp `metadata.sb`. This proof does not assert
 * `metadata.sb.stage` for that reason; it asserts `kind` instead, which the
 * tool schema DOES carry, and which `kit.ts`'s shared rule tells every
 * specialist to set to its stage's `STAGE_ARTIFACT_KIND`.
 *
 * Usage: bun --conditions intx-src scripts/specialist-artifact-proof.ts
 *   SMOKE_PROVIDER_BASE_URL / SMOKE_PROVIDER_API_KEY -- as in e2e-client.ts.
 */
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import {
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
import { STAGE_ARTIFACT_KIND } from "@solutions-builder/app/specialist-source";
import { buildManifest, buildPackedEntries } from "./closure-pack.ts";
import { readStageThread, sendStageMail } from "../apps/web/src/stage-mail.ts";

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

type RunEvent = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

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

function dumpRunEvents(label: string, events: readonly RunEvent[]): void {
  console.log(`--- ${label} events ---`);
  for (const event of events) {
    const stepId = event.body["stepId"];
    const statusOrError = event.body["status"] ?? event.body["error"] ?? event.body["reason"] ?? event.body["message"];
    console.log(
      [String(event.seq), event.type, stepId !== undefined ? String(stepId) : "-", statusOrError !== undefined ? String(statusOrError) : ""]
        .join(" ")
        .trimEnd(),
    );
  }
}

function dumpHostOutput(host: Host): void {
  console.log("--- host stderr ---");
  console.log(host.stderrRing.get().join("\n"));
  console.log("--- host stdout ---");
  console.log(host.stdoutRing.get().join("\n"));
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : typeof cause === "object" ? JSON.stringify(cause) : String(cause);
    check(name, false, detail);
    return null;
  }
}

const root = join(import.meta.dir, "..");
const ENTRY = join(root, "apps", "hub", "src", "server.ts");

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

/** Boots the app's own host against a fresh temp data dir, outside the repo. */
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

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutRing.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // process exited / stream closed
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
      // process exited / stream closed
    } finally {
      stderrReader.releaseLock();
    }
  })();

  return { process: child, token, port, stdoutRing, stderrRing };
}

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
      throw new Error("subscribe() is not used by this proof");
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

const DEFAULT_SMOKE_PROVIDER_BASE_URL = "https://thegreataxios-home-studio.tail87f5aa.ts.net/v1";
const PREFERRED_MODELS = ["gpt-oss:20b", "qwen2.5:14b", "qwen2.5:7b"];

/** Lists servable models and picks a tool-capable one, preferring `gpt-oss:20b`. */
async function discoverModel(baseUrl: string, apiKey: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`the provider rejected this key (HTTP ${response.status})`);
  const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const ids = (body?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) throw new Error("this key works, but the provider did not list any model");
  const preferred = PREFERRED_MODELS.find((name) => ids.includes(name));
  return preferred ?? ids[0]!;
}

const PROJECT_POLICY: ProjectPolicy = {
  costTolerancePercent: 20,
  costToleranceAbsolute: 500,
  audiences: [],
  audienceQuorum: 1,
  allowExternalProviders: false,
};

async function closureAndPush(origin: string, hostToken: string): Promise<{ closure: ClosureSource; gitPush: WorkflowGitPush }> {
  const entries = await buildPackedEntries();
  const manifest = buildManifest("scripts/specialist-artifact-proof.ts", entries);
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
    const dir = await mkdtemp(join(tmpdir(), "specialist-artifact-proof-push-"));
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
  const dataDir = await mkdtemp(join(tmpdir(), "sb-specialist-artifact-proof-"));
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

    const email = `owner+${Date.now()}@specialist-artifact-proof.invalid`;
    const password = "Sm0ke-Test-Pass-2026!";
    await step("1. sign up over /api/auth/sign-up/email", async () => {
      const { response, parsed } = await authFetch(origin, host!.token, cookieJar, "/sign-up/email", {
        email,
        password,
        name: "Specialist Artifact Proof",
      });
      const user = (parsed as { user?: { id?: string } } | undefined)?.user;
      check("1. sign up over /api/auth/sign-up/email", response.ok && typeof user?.id === "string");
    });

    const sidecar = await step("boot: sidecar placement facts from GET /api/status", async () => {
      const response = await fetch(`${origin}/api/status`, { headers: { authorization: `Bearer ${host!.token}` } });
      const body = (await response.json()) as { canPlaceSidecars?: boolean };
      const ok = response.ok && body.canPlaceSidecars === true;
      check("boot: sidecar placement facts from GET /api/status", ok, JSON.stringify(body));
      if (!ok) throw new Error("no sidecar capability to deploy against");
      return { canPlaceSidecars: true } satisfies SidecarCapability;
    });

    const { closure, gitPush } = await closureAndPush(origin, host.token);

    const workspace = await step("2. workspace tenant install", async () => {
      if (!sidecar) throw new Error("no sidecar capability from the boot step");
      const state = await installerInstall(transport);
      check("2. workspace tenant install", state.installed, state.detail);
      const resolved = await resolveWorkspace(transport);
      if (!resolved) throw new Error("the hub installed the workspace but does not resolve it back");
      return resolved;
    });

    const baseURL = (process.env.SMOKE_PROVIDER_BASE_URL ?? DEFAULT_SMOKE_PROVIDER_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env.SMOKE_PROVIDER_API_KEY ?? "ollama";
    await step("3. connect an OpenAI-compatible provider", async () => {
      if (!workspace) throw new Error("no workspace to connect a provider under");
      const canonicalName = await discoverModel(baseURL, apiKey);
      const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
        providerId: "specialist-artifact-proof-openai-compatible",
        label: "Specialist Artifact Proof",
        plugin: "openai-compatible",
        baseURL,
        apiKey,
      });
      await registerProviderModels(transport, workspace.tenantId, { modelProviderId, canonicalNames: [canonicalName] });
      check("3. connect an OpenAI-compatible provider", true, `${canonicalName} at ${baseURL}`);
    });

    const project = await step("4. create a project", async () => {
      if (!workspace) throw new Error("no workspace to open a project under");
      const { project: created } = await installerCreateProject(transport, workspace.tenantId, {
        title: "Specialist Artifact Proof Project",
        slug: `specialist-artifact-proof-${Date.now()}`,
        policy: PROJECT_POLICY,
      });
      check("4. create a project", true, `project ${created.id}`);
      return created;
    });

    const dumpDeploymentEvents = async (label: string, tenantId: string, deploymentId: string): Promise<void> => {
      const { events } = await readWorkflowRunEvents(transport, tenantId, deploymentId, deploymentId);
      dumpRunEvents(label, events as RunEvent[]);
    };

    const pollAgentReply = async (tenantId: string, address: string, agentReplyCount: number, timeoutMs = 360_000) =>
      pollUntil(timeoutMs, 3_000, async () => {
        const thread = await readStageThread(tenantId, [address]);
        const agentMessages = thread.filter((message) => message.author === "agent");
        return agentMessages.length > agentReplyCount ? agentMessages[agentMessages.length - 1]! : null;
      });

    const stage1 = await step("5. ensureSpecialistDeployment for stage 1 (mints the workflow-artifacts credential)", async () => {
      if (!workspace || !project || !sidecar) throw new Error("no workspace/project/sidecar to deploy against");
      const deployed = await ensureSpecialistDeployment(transport, sidecar, closure, gitPush, workspace.tenantId, project.id, 1, origin);
      check("5. ensureSpecialistDeployment for stage 1", true, JSON.stringify(deployed));
      return deployed;
    });

    // (6) Mail the opening problem statement and wait (up to 6 minutes) for the
    // specialist's reply. Approval requests the artifact tools raise would show
    // up in the run's own events (dumped on a timeout below) -- none are
    // expected here, since `onArtifactCreated` mints the creator's own write/
    // archive grants and this run's `credentialBindings` resolves its own
    // credential without an `ask` grant.
    const OPENING = "Build a small internal tool that tracks team OKRs across quarters.";
    const reply = await step("6. mail the opening problem statement and poll for a reply (up to 6m)", async () => {
      if (!workspace || !stage1) throw new Error("no workspace/stage-1 deployment to mail");
      await sendStageMail(workspace.tenantId, stage1.address, { body: OPENING, subject: "New project" });
      const found = await pollAgentReply(workspace.tenantId, stage1.address, 0);
      if (!found) await dumpDeploymentEvents(`deployment ${stage1.deploymentId}`, workspace.tenantId, stage1.deploymentId);
      check(
        "6. mail the opening problem statement and poll for a reply (up to 6m)",
        found !== null,
        found ? found.id : "no reply within 360s",
      );
      if (!found) throw new Error(`no reply from ${stage1.address} within 360s`);
      return found;
    });

    // A specialist's first turn often asks clarifying questions before it
    // drafts anything (the kit's own rule) rather than writing on turn one.
    // A short, direct follow-up either way gets it to actually call
    // artifact_create/artifact_write and name what it wrote.
    const secondReply = await step("6b. mail a follow-up asking it to write the brief now, poll for a second reply", async () => {
      if (!workspace || !stage1) throw new Error("no workspace/stage-1 deployment to mail");
      await sendStageMail(workspace.tenantId, stage1.address, {
        body: "Assume reasonable defaults for anything you'd ask about. Write the problem brief now.",
        subject: "Re: New project",
      });
      const found = await pollAgentReply(workspace.tenantId, stage1.address, 1);
      if (!found) await dumpDeploymentEvents(`deployment ${stage1.deploymentId}`, workspace.tenantId, stage1.deploymentId);
      check(
        "6b. mail a follow-up asking it to write the brief now, poll for a second reply",
        found !== null,
        found ? found.id : "no second reply within 360s",
      );
      return found;
    });

    await step("6. the reply names the artifact it wrote", async () => {
      const last = secondReply ?? reply;
      if (!last) throw new Error("no reply to read");
      check("6. the reply names the artifact it wrote", /artifact/i.test(last.body), last.body.slice(0, 300));
    });

    // (7) The real assertion: the specialist's OWN tool call produced a real,
    // server-stamped artifact -- read back through the browser surface, since
    // that is the one read route that exposes `source`/`contentSha256`.
    await step("7. a workflow-origin artifact exists, stamped with this run and a digest", async () => {
      if (!workspace || !stage1) throw new Error("no workspace/stage-1 deployment to check");
      const kind = STAGE_ARTIFACT_KIND[1];
      const artifacts = await listArtifacts(transport, workspace.tenantId, { kind });
      const mine = artifacts.find((artifact) => artifact.source.origin === "workflow");
      const runId = mine ? (mine.source["runId"] as string | undefined) : undefined;
      const runIdMatches = runId === stage1.deploymentId || (runId?.startsWith(`${stage1.deploymentId}__`) ?? false);
      const ok = mine !== undefined && runIdMatches && typeof mine.contentSha256 === "string" && mine.contentSha256.length > 0;
      if (!ok) await dumpDeploymentEvents(`deployment ${stage1.deploymentId}`, workspace.tenantId, stage1.deploymentId);
      check(
        "7. a workflow-origin artifact exists, stamped with this run and a digest",
        ok,
        mine
          ? `artifact ${mine.id} v${mine.version} kind=${mine.kind} runId=${String(runId)} contentSha256=${String(mine.contentSha256)}`
          : `no workflow-origin ${kind} artifact found (${artifacts.length} artifact(s) of that kind) -- the specialist may not have called artifact_create this run`,
      );
      console.log(
        "NOTE: metadata.sb (projectId/stage/mediaType/provenance) is not asserted here -- at the pinned " +
          "@corbits/artifacts commit (0190e6c), mountWorkflowArtifacts's create/revise bodies and the " +
          "sidecar-bundle's tool schemas carry no metadata field, so a specialist cannot stamp it. See the CL-8719 report.",
      );
    });

    const passed = checks.filter((entry) => entry.ok).length;
    console.log(`\nSpecialist artifact proof: ${passed}/${checks.length} checks passed`);
    if (passed !== checks.length) process.exitCode = 1;
  } finally {
    host?.process.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
