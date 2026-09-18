/**
 * Client-driven end-to-end proof: signup to delivery, over hub routes only.
 *
 * Drives the product exactly as the browser does -- `packages/installer`,
 * `@intx/hub-client`, and the mounted corbitsdev routes reached through the
 * host's `/hub` mount over an embedded hub (the same one `packages/embed-hub`
 * composes; booted here by spawning the app's own host, `apps/hub/src/server.ts`,
 * the way `scripts/hub-topology-smoke.ts` and `scripts/launch-smoke.ts` already
 * do). This script owns nothing in `apps/hub/src`; every product call below
 * goes through `/hub/*` -- the same seam the browser is limited to -- and the
 * two host routes it does call (`GET /api/status` for sidecar placement facts,
 * the outer-door bearer) are the same read-only boot facts the existing
 * smokes already reach for.
 *
 * Each step prints PASS/FAIL and continues past a failure, so a break in the
 * client-driven chain shows up as one failed step rather than an aborted run.
 *
 * Usage: bun --conditions intx-src scripts/e2e-client.ts
 *   SMOKE_PROVIDER_API_KEY (or ANTHROPIC_API_KEY) -- an Anthropic key to
 *   connect as the workspace's provider. Absent, step 3 is skipped and every
 *   step after it that needs a servable offering is expected to report
 *   "no_offering" rather than fail outright.
 */
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Transport } from "@intx/hub-client";
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
  type ProjectPolicy,
  type SidecarCapability,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { buildManifest, buildPackedEntries } from "./closure-pack.ts";
import { listProjectSummaries } from "../apps/web/src/project-list.ts";
import { foldProject } from "../apps/web/src/run-fold.ts";
import { deliverDraft, deliverGate } from "../apps/web/src/run-signal.ts";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  return ok;
}
function skip(name: string, detail: string): void {
  console.log(`SKIP  ${name} - ${detail}`);
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

type Host = { process: Bun.Subprocess; token: string; port: number };

/** Boots the app's own host, which mounts `packages/embed-hub`'s app at `/hub`. */
async function startHost(dataDir: string): Promise<Host> {
  const child = Bun.spawn(["bun", "--conditions", "intx-src", ENTRY, "--port", "0"], {
    cwd: root,
    env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 150_000;
  let token = "";
  let port = 0;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (Date.now() < deadline && !token) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = /launch URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9-]+)/.exec(buffer);
    if (match) {
      port = Number(match[1]);
      token = match[2]!;
    }
  }
  reader.releaseLock();
  if (!token) {
    const stderr = await new Response(child.stderr).text().catch(() => "");
    throw new Error(`the host never reached its handshake - ${stderr.slice(-400) || buffer.slice(-200)}`);
  }
  return { process: child, token, port };
}

/**
 * A `Transport` against a real origin's `/hub` mount: the outer-door bearer
 * plus whatever session cookie the last auth call set, so every call after
 * sign-up rides the same session a browser tab would keep in its cookie jar.
 */
function createTransport(origin: string, hostToken: string): { transport: Transport; cookieJar: { value: string } } {
  const cookieJar = { value: "" };
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = { authorization: `Bearer ${hostToken}` };
      if (cookieJar.value) headers.cookie = cookieJar.value;
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${origin}/hub${path}`, init);
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
        throw new Error(
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

async function authFetch(origin: string, hostToken: string, cookieJar: { value: string }, path: string, body: unknown) {
  const response = await fetch(`${origin}/hub/api/auth${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostToken}`,
      "content-type": "application/json",
      ...(cookieJar.value ? { cookie: cookieJar.value } : {}),
    },
    body: JSON.stringify(body),
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
 * the packer, and the push over the spawned host's real `/hub`-mounted git
 * smart-HTTP route -- unlike that script, this one talks to a real listening
 * socket, so the push rides the plain global `fetch` `pushSourceTree`
 * defaults to, no `app.fetch` adapter needed.
 */
async function closureAndPush(origin: string): Promise<{ closure: ClosureSource; gitPush: WorkflowGitPush }> {
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
  const gitPush: WorkflowGitPush = async ({ scope, assetKind, assetName, token, tree, message }) => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-client-push-"));
    try {
      const url = `${origin}/hub/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`;
      return await pushSourceTree({ url, token, tree, message, fsBackend: { fs, dir } });
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
    const origin = `http://127.0.0.1:${host.port}`;
    const { transport, cookieJar } = createTransport(origin, host.token);

    // (1) Sign up / session.
    const email = `owner+${Date.now()}@e2e-client-proof.invalid`;
    const password = "Sm0ke-Test-Pass-2026!";
    await step("1. sign up over /hub/api/auth/sign-up/email", async () => {
      const { response, parsed } = await authFetch(origin, host!.token, cookieJar, "/sign-up/email", {
        email,
        password,
        name: "E2E Client Proof",
      });
      const user = (parsed as { user?: { id?: string; email?: string } } | undefined)?.user;
      check(
        "1. sign up over /hub/api/auth/sign-up/email",
        response.ok && typeof user?.id === "string",
        response.ok ? "" : `HTTP ${response.status} ${JSON.stringify(parsed).slice(0, 200)}`,
      );
      const session = await authFetch(origin, host!.token, cookieJar, "/get-session", {});
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
      return { canPlaceSidecars: true, sidecarFingerprint: body.sidecarFingerprint! } satisfies SidecarCapability;
    });

    const { closure, gitPush } = await closureAndPush(origin);

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

    // (3) Connect an API-key provider.
    const apiKey = process.env.SMOKE_PROVIDER_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      skip("3. connect an API-key provider", "no SMOKE_PROVIDER_API_KEY (or ANTHROPIC_API_KEY) in the environment");
    } else if (workspace) {
      await step("3. connect an API-key provider", async () => {
        const { modelProviderId } = await upsertApiKeyProvider(transport, workspace.tenantId, {
          providerId: "anthropic",
          label: "Anthropic",
          plugin: "anthropic",
          baseURL: DEFAULT_BASE_URL.anthropic!,
          apiKey,
        });
        // Model discovery calls the vendor's own API (the "inference step");
        // this smoke skips it and records the canonical name it already knows.
        await registerProviderModels(transport, workspace.tenantId, {
          modelProviderId,
          canonicalNames: ["claude-3-5-sonnet-20241022"],
        });
        check("3. connect an API-key provider", true, `model provider ${modelProviderId}`);
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

    // (6) Deliver stage.draft, then the gate approve, folding the run between.
    const anchorRunId = deployment && "deploymentId" in deployment ? deployment.deploymentId : null;
    await step("6. deliver stage.draft over the run-signal pattern", async () => {
      if (!project || !anchorRunId) throw new Error("no project/anchor run to signal");
      await deliverDraft(
        { tenantId: project.id, anchorRunId },
        1,
        {
          command: "stage.draft",
          runId: anchorRunId,
          message: "Build a small internal tool that tracks team OKRs.",
          mode: "final",
          draft: true,
          inference: { maxTokens: 32_000 },
        },
        transport,
      );
      check("6. deliver stage.draft over the run-signal pattern", true);
    });

    const partedAtGate = await step("6. fold the run until it parks at stage 1's gate", async () => {
      if (!project || !anchorRunId) throw new Error("no project/anchor run to fold");
      const deadline = Date.now() + 120_000;
      let status = await foldProject(project.id, anchorRunId, transport);
      while (Date.now() < deadline && !(status?.parked && status.stage === 1)) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        status = await foldProject(project.id, anchorRunId, transport);
      }
      const ok = status?.parked === true && status.stage === 1;
      check(
        "6. fold the run until it parks at stage 1's gate",
        ok,
        JSON.stringify(status).slice(0, 200),
      );
      if (!ok) throw new Error(`the run never parked at stage 1's gate: ${JSON.stringify(status)}`);
      return status;
    });

    await step("6. deliver the gate approve signal", async () => {
      if (!project || !anchorRunId) throw new Error("no project/anchor run to signal");
      await deliverGate(
        { tenantId: project.id, anchorRunId },
        1,
        partedAtGate,
        { command: "stage.approve", runId: anchorRunId },
        transport,
      );
      check("6. deliver the gate approve signal", true);
    });

    await step("6. fold the run past the approved gate", async () => {
      if (!project || !anchorRunId) throw new Error("no project/anchor run to fold");
      const deadline = Date.now() + 60_000;
      let status = await foldProject(project.id, anchorRunId, transport);
      const before = partedAtGate?.stage;
      while (Date.now() < deadline && status !== null && status.stage === before && status.parked) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        status = await foldProject(project.id, anchorRunId, transport);
      }
      check(
        "6. fold the run past the approved gate",
        status !== null && status.stage !== before,
        JSON.stringify(status).slice(0, 200),
      );
    });

    // (7) List artifacts via the artifacts client.
    await step("7. list artifacts via the artifacts client", async () => {
      if (!project) throw new Error("no project to list artifacts under");
      const artifacts = await listArtifacts(transport, project.id);
      check("7. list artifacts via the artifacts client", true, `${artifacts.length} artifact(s)`);
    });

    // (8) Confirm the mailbox inbox has an item for the parked gate.
    await step("8. mailbox inbox carries an item for the parked gate", async () => {
      const response = await fetch(`${origin}/hub/api/me/inbox`, {
        headers: { authorization: `Bearer ${host!.token}`, cookie: cookieJar.value },
      });
      if (!response.ok) throw new Error(`GET /hub/api/me/inbox -> HTTP ${response.status}`);
      const body = (await response.json()) as { messages?: unknown[] };
      const ok = Array.isArray(body.messages) && body.messages.length > 0;
      check("8. mailbox inbox carries an item for the parked gate", ok, `${body.messages?.length ?? 0} message(s)`);
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
}
process.exit(failed.length === 0 ? 0 : 1);
