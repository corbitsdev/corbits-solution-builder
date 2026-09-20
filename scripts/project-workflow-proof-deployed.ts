import "./smoke-env.ts";

import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  deliverWorkflowSignal,
  listWorkflowDeployments,
  listWorkflowRuns,
  readWorkflowRunEvents,
  triggerWorkflowRun,
  type Transport,
} from "@intx/hub-client";
import {
  createWorkspace,
  ensureWorkflowAsset,
  pushSourceTree,
  pushWorkflowSourceTree,
  registerProviderModels,
  upsertApiKeyProvider,
  vendoredMemberFiles,
  waitForPushVisible,
  workflowsFor,
  type FetchLike,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { buildManifest, buildPackedEntries } from "./closure-pack.ts";
import { buildProjectWorkflowEntryFiles } from "./project-workflow-pack.ts";
import { assertNoReplay, assertParked, eventSummary, logSummary, runCompletedCount, stepExecutionCounts, type ProofEvent } from "./project-workflow-proof-evidence.ts";
import {
  allocationIdentity,
  bounded,
  cleanupDescendants,
  inspectProcess,
  isolatedLaunch,
  ProofFailure,
  receiptFor,
  request,
  safeFailure,
  verifyIdentity,
  type Receipt,
} from "./project-workflow-proof-safety.ts";

const root = join(import.meta.dir, "..");
const entry = join(import.meta.dir, "project-workflow-proof-host.ts");
const workerEntry = join(root, "vendor/interchange/apps/sidecar/src/index.ts");
const childEntries = ["workflow-child", "workflow-probe-child"].map((name) => join(root, "vendor/interchange/apps/sidecar/bin", name));

let dataDir = "";
let evidenceDir = "";
let scenario = AbortSignal.abort();
let phase = "setup";
let hostPids = new Set<number>();
let boot = 0;

type Host = { process: Bun.Subprocess; identity: Receipt; token: string; port: number; snapshot: () => Promise<unknown>; closeReaders: () => Promise<void> };

async function startHost(): Promise<Host> {
  scenario.throwIfAborted();
  const logPath = join(evidenceDir, `host-${++boot}.jsonl`);
  let receive: ((snapshot: unknown) => void) | undefined;
  const launch = await isolatedLaunch(dataDir);
  const proc = Bun.spawn([launch.executable, ...launch.args, "--conditions", "intx-src", entry, "--port", "0"], {
    cwd: root,
    env: launch.env,
    stdout: "pipe",
    stderr: "pipe",
    ipc(message) { receive?.(message); },
  });
  const identity: Receipt = { ...inspectProcess(proc.pid), entry, executable: launch.executable, data: null, isolated: true };
  hostPids.add(proc.pid);
  const record = (stream: string, text: string) => {
    for (const line of text.split("\n")) if (line) fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), stream, ...logSummary(line) })}\n`);
  };
  const stderrReader = proc.stderr.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      record("stderr", decoder.decode(value, { stream: true }));
    }
  })();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startup = AbortSignal.any([scenario, AbortSignal.timeout(60_000)]);
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), startup);
      if (done) {
        record("stdout", buffer);
        throw new Error("project workflow proof host exited before handshake");
      }
      buffer += decoder.decode(value, { stream: true });
      const match = /launch URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9-]+)/.exec(buffer);
      if (match) {
        verifyIdentity(await receiptFor(dataDir, proc.pid), inspectProcess(proc.pid), { entry, parent: globalThis.process.pid });
        record("stdout", buffer);
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              record("stdout", decoder.decode(value, { stream: true }));
            }
          } finally {
            reader.releaseLock();
          }
        })();
        return {
          process: proc, identity, port: Number(match[1]), token: match[2]!,
          closeReaders: async () => { await Promise.all([reader.cancel().catch(() => undefined), stderrReader.cancel().catch(() => undefined)]); },
          snapshot: () => bounded(new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("proof snapshot timed out")), 10_000);
            receive = (message) => { clearTimeout(timer); receive = undefined; resolve(message); };
            proc.send("snapshot");
          }), scenario),
        };
      }
    }
  } catch (error) {
    if (proc.exitCode === null) {
      verifyIdentity(identity, inspectProcess(proc.pid), { entry, parent: globalThis.process.pid });
      proc.kill("SIGKILL");
    }
    proc.disconnect();
    await cleanupDescendants(dataDir, hostPids, workerEntry, childEntries);
    void reader.cancel().catch(() => undefined);
    void stderrReader.cancel().catch(() => undefined);
    throw error;
  }
}

function transportFor(host: Host, cookie: { value: string }): Transport {
  const origin = `http://127.0.0.1:${host.port}`;
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = { authorization: `Bearer ${host.token}`, origin };
      if (cookie.value) headers.cookie = cookie.value;
      const response = await request(`${origin}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, scenario);
      if (path.endsWith("/signals")) {
        fs.appendFileSync(join(evidenceDir, "signal-http.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), method, status: response.status })}\n`);
      }
      const setCookies = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const raw of setCookies) cookie.value = raw.split(";")[0] ?? cookie.value;
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : undefined;
      if (!response.ok) {
        const detail = parsed as { error?: { code?: string; message?: string } } | undefined;
        const code = detail?.error?.code === "workflow_run_not_running" || detail?.error?.code === "signal_id_conflict" ? detail.error.code : "proof_http_error";
        if (process.env["PROOF_DEBUG"]) console.error("HTTP error detail:", detail);
        const httpError = new ApiError(response.status, code, "proof HTTP failure");
        throw httpError;
      }
      return parsed as T;
    },
    subscribe: () => { throw new Error("subscriptions are not used by the project workflow proof"); },
  };
}

async function signUp(host: Host, cookie: { value: string }): Promise<void> {
  const origin = `http://127.0.0.1:${host.port}`;
  const response = await request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", origin },
    body: JSON.stringify({ email: `project-workflow-${Date.now()}@proof.invalid`, password: `Proof-${crypto.randomUUID()}-aA1!`, name: "Project Workflow Proof" }),
  }, scenario);
  for (const raw of (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
    cookie.value = raw.split(";")[0] ?? cookie.value;
  }
  if (!response.ok) throw new Error(`sign-up failed with HTTP ${response.status}`);
}

const PROJECT_ID = "deployed-proof-project";
const SIGNAL_NAME = "project.decision";
const LOOP_STEP_ID = "rework";
const AT = "2026-09-19T00:00:00.000Z";

// REAL-SHAPED references only: the workflow never reads an artifact's
// content, only compares the reference (artifactId/version/sha256) a
// decision names against the one an earlier decision opened, so these are
// plain fixture strings, not real content hashes.
const STAGE1_ARTIFACT = `${PROJECT_ID}-stage-1-artifact`;
const STAGE2_ARTIFACT = `${PROJECT_ID}-stage-2-artifact`;
const SHA = { stage1v1: "sha-fixture-stage-1-v1", stage1v2: "sha-fixture-stage-1-v2", stage2v1: "sha-fixture-stage-2-v1", stage2v2: "sha-fixture-stage-2-v2" };

function initPayload(ownerPrincipalId: string) {
  return {
    projectId: PROJECT_ID,
    stages: [
      { stage: 1, authorizedPrincipalIds: [ownerPrincipalId] },
      { stage: 2, authorizedPrincipalIds: [ownerPrincipalId] },
    ],
  };
}

function openReview(decisionId: string, stage: number, artifactId: string, version: number, sha256: string) {
  return { decisionId, kind: "open_review", projectId: PROJECT_ID, stage, artifactId, version, sha256, at: AT };
}
function approve(decisionId: string, stage: number, reviewId: string, artifactId: string, version: number, sha256: string, overrides: Record<string, unknown> = {}) {
  return { decisionId, kind: "approve", projectId: PROJECT_ID, stage, reviewId, artifactId, version, sha256, at: AT, ...overrides };
}
function sendBack(decisionId: string, stage: number, targetStage: number, reason: string) {
  return { decisionId, kind: "send_back", projectId: PROJECT_ID, stage, targetStage, reason, at: AT };
}

function decodeInlineOutput(ref: unknown): unknown {
  if (typeof ref !== "string" || !ref.startsWith("inline:")) return undefined;
  return JSON.parse(ref.slice("inline:".length));
}

async function deployProjectWorkflow(host: Host, cookie: { value: string }) {
  const transport = transportFor(host, cookie);
  phase = "workspace";
  const workspace = await createWorkspace(transport);
  const provider = await upsertApiKeyProvider(transport, workspace.tenantId, {
    providerId: "project-workflow-proof-inert",
    label: "Project workflow proof inert source",
    plugin: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "non-secret-proof-placeholder",
  });
  await registerProviderModels(transport, workspace.tenantId, { modelProviderId: provider.modelProviderId, canonicalNames: ["never-invoked"] });
  const offering = (await import("@solutions-builder/installer")).catalogFor(transport, workspace.tenantId);
  const offeringId = (await offering.offerings())[0]!.id;

  phase = "closure";
  const packed = await bounded(buildPackedEntries(), scenario);
  const manifest = buildManifest("scripts/project-workflow-proof-deployed.ts", packed);
  const bytes = new Map(packed.map((item) => [item.filename, item.bytes]));
  const entries = await bounded(buildProjectWorkflowEntryFiles(), scenario);
  const memberPkgJson = {
    name: "project-workflow-deployed-proof",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { "@intx/workflow": "workspace:*", hono: "^4.0.0" },
    interchange: { workflow: "./workflow.js", actions: "./actions.js", loops: "./loops.js" },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "project-workflow-proof-workspace", private: true, type: "module", workspaces: ["packages/*"], catalog: manifest.catalog }, null, 2)}\n`,
    "packages/proof/package.json": `${JSON.stringify(memberPkgJson, null, 2)}\n`,
    "packages/proof/workflow.js": entries["workflow.js"],
    "packages/proof/actions.js": entries["actions.js"],
    "packages/proof/loops.js": entries["loops.js"],
    "proof.marker": "project-workflow-proof-v2\n",
    ...(await vendoredMemberFiles(manifest, async (filename) => bytes.get(filename)!)),
  };
  const assetName = "project-workflow-deployed-proof";
  const assetId = await ensureWorkflowAsset(transport, workspace.tenantId, assetName, "Project workflow deployed proof");
  const origin = `http://127.0.0.1:${host.port}`;
  const fetchImpl: FetchLike = (input, init) => request(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: `solutions_builder_session=${host.token}` } }, scenario);
  const gitPush: WorkflowGitPush = async ({ scope, assetKind, assetName: pushAssetName, token, tree, message }) => {
    const dir = await mkdtemp(join(tmpdir(), "project-workflow-proof-push-"));
    return pushSourceTree({ url: `${origin}/api/tenants/${scope}/assets/${assetKind}/${pushAssetName}.git`, token, tree, message, fsBackend: { fs, dir }, fetchImpl });
  };
  phase = "push";
  const commitSha = await pushWorkflowSourceTree(transport, workspace.tenantId, assetId, assetName, files, "Deploy project workflow proof", gitPush);
  await waitForPushVisible(transport, workspace.tenantId, assetId, "proof.marker", "project-workflow-proof-v2\n");
  phase = "deploy";
  const deployed = await workflowsFor(transport, workspace.tenantId).deploy({
    source: { kind: "asset", assetId, package: { format: "source", commitSha, packageName: "project-workflow-deployed-proof" } },
    entry: "./workflow.js",
    sourceOfferingIds: [offeringId],
    defaultSourceOfferingId: offeringId,
  });
  for (let i = 0; i < 120; i++) {
    scenario.throwIfAborted();
    const current = (await listWorkflowDeployments(transport, workspace.tenantId)).find((item) => item.id === deployed.id);
    if (current?.status === "deployed") break;
    if (current?.status === "failed" || current?.status === "released") throw new Error(`deployment ended ${current.status}`);
    await Bun.sleep(500);
  }
  return { workspace, deployed, offeringId };
}

async function readTopEvents(transport: Transport, tenantId: string, deploymentId: string, runId: string): Promise<ProofEvent[]> {
  return (await readWorkflowRunEvents(transport, tenantId, deploymentId, runId)).events as ProofEvent[];
}

async function pollUntilParked(transport: Transport, tenantId: string, deploymentId: string, runId: string, tries = 120): Promise<ProofEvent[]> {
  for (let i = 0; i < tries; i++) {
    scenario.throwIfAborted();
    const events = await readTopEvents(transport, tenantId, deploymentId, runId).catch(() => null);
    if (events && events.some((e) => e.type === "SignalAwaited" && e.body.stepId === LOOP_STEP_ID)) {
      assertParked(events, LOOP_STEP_ID);
      return events;
    }
    await Bun.sleep(500);
  }
  throw new Error("project workflow did not park on the loop's signal relay");
}

async function pollUntilCompleted(transport: Transport, tenantId: string, deploymentId: string, runId: string, tries = 300): Promise<ProofEvent[]> {
  for (let i = 0; i < tries; i++) {
    scenario.throwIfAborted();
    const events = await readTopEvents(transport, tenantId, deploymentId, runId);
    if (events.some((e) => e.type === "RunCompleted")) return events;
    await Bun.sleep(500);
  }
  throw new Error("project workflow did not complete");
}

/** The loop's committed final state, off the container's own StepCompleted output. */
function finalStateFrom(events: ProofEvent[]): { done: boolean; decisions: unknown[]; stage: number } | undefined {
  const completed = events.find((e) => e.type === "StepCompleted" && e.body.stepId === LOOP_STEP_ID);
  const decoded = decodeInlineOutput((completed?.body.output as { ref?: unknown } | undefined)?.ref) as
    | { final?: { apply?: { done: boolean; decisions: unknown[]; stage: number } } }
    | undefined;
  return decoded?.final?.apply;
}

function iterationRunIds(runs: string[], runId: string): string[] {
  const prefix = `${runId}__${LOOP_STEP_ID}__`;
  return runs.filter((id) => id.startsWith(prefix)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

async function iterationCount(transport: Transport, tenantId: string, deploymentId: string, runId: string): Promise<number> {
  const runs = await listWorkflowRuns(transport, tenantId, runId);
  return iterationRunIds(runs, runId).length;
}

/** Decode a plain action step's own StepCompleted output (not the loop container's wrapped `final.apply`). */
function applyStepOutputFrom(events: ProofEvent[] | null): { stage: number; done: boolean; decisions: unknown[]; reviews: Record<string, { status: string }> } | undefined {
  const completed = events?.find((e) => e.type === "StepCompleted" && e.body.stepId === "apply");
  return decodeInlineOutput((completed?.body.output as { ref?: unknown } | undefined)?.ref) as
    | { stage: number; done: boolean; decisions: unknown[]; reviews: Record<string, { status: string }> }
    | undefined;
}

/**
 * The stale top-level check this replaces: `events.some(SignalAwaited for
 * LOOP_STEP_ID)` is permanently true from the FIRST iteration onward, so it
 * returns instantly on every later call. Real quiescence requires the
 * NEWEST loop-iteration child run to exist and be parked on its own `wait`
 * step, with no later `SignalReceived`/`StepCompleted` for `wait`, and (for
 * iterations after the first) the PREVIOUS iteration's `apply` step
 * committed.
 */
async function waitForIterationParked(
  transport: Transport,
  tenantId: string,
  deploymentId: string,
  runId: string,
  expectedIterations: number,
  tries = 240,
): Promise<ProofEvent[]> {
  for (let i = 0; i < tries; i++) {
    scenario.throwIfAborted();
    const runs = await listWorkflowRuns(transport, tenantId, runId).catch(() => null);
    const iterations = runs ? iterationRunIds(runs, runId) : [];
    if (iterations.length === expectedIterations) {
      const newest = iterations[iterations.length - 1]!;
      const newestEvents = await readTopEvents(transport, tenantId, deploymentId, newest).catch(() => null);
      const parkedOnWait = !!newestEvents
        && newestEvents.some((e) => e.type === "SignalAwaited" && e.body.stepId === "wait")
        && !newestEvents.some((e) => (e.type === "SignalReceived" || e.type === "StepCompleted") && e.body.stepId === "wait");
      let previousApplied = expectedIterations <= 1;
      if (parkedOnWait && !previousApplied) {
        const previous = iterations[iterations.length - 2]!;
        const previousEvents = await readTopEvents(transport, tenantId, deploymentId, previous).catch(() => null);
        previousApplied = !!previousEvents && previousEvents.some((e) => e.type === "StepCompleted" && e.body.stepId === "apply");
      }
      if (parkedOnWait && previousApplied) {
        const events = await readTopEvents(transport, tenantId, deploymentId, runId);
        assertParked(events, LOOP_STEP_ID);
        return events;
      }
    }
    await Bun.sleep(500);
  }
  // Event types and step ids only: enough to tell "signal never consumed"
  // from "recovered in a different shape", and nothing sensitive.
  const shape = (events: ProofEvent[] | null) =>
    (events ?? []).slice(-8).map((e) => `${e.type}${typeof e.body.stepId === "string" ? `:${e.body.stepId}` : ""}`).join(",");
  const runs = (await listWorkflowRuns(transport, tenantId, runId).catch(() => [])) ?? [];
  const iterations = iterationRunIds(runs, runId);
  const newest = iterations[iterations.length - 1];
  const newestShape = newest ? shape(await readTopEvents(transport, tenantId, deploymentId, newest).catch(() => null)) : "none";
  const topShape = shape(await readTopEvents(transport, tenantId, deploymentId, runId).catch(() => null));
  const newestEvents = newest ? await readTopEvents(transport, tenantId, deploymentId, newest).catch(() => null) : null;
  const failure = (newestEvents ?? []).find((e) => e.type === "StepFailed");
  const reason = failure
    ? JSON.stringify(failure.body).replace(/\/[^\s"':]+/g, "<path>").slice(0, 400)
    : "none";
  throw new Error(
    `first StepFailed in newest iteration: ${reason}\n` +
    `project workflow did not park inside loop iteration ${String(expectedIterations)} ` +
    `(iterations=${String(iterations.length)}; newest=[${newestShape}]; top=[${topShape}])`,
  );
}

type Signal = { runId: string; signalName: string; signalId: string; payload: unknown };

async function runScenario(mode: "full" | "idempotency" | "host-restart" | "run-child-loss"): Promise<void> {
  phase = "setup";
  evidenceDir = "";
  hostPids = new Set();
  dataDir = await mkdtemp(join(tmpdir(), `sb-project-workflow-${mode}-`));
  evidenceDir = join(dataDir, "sanitized-evidence");
  await fs.promises.mkdir(evidenceDir);
  scenario = AbortSignal.timeout(300_000);
  console.log(`SHARE ONLY ${evidenceDir}/*.json and *.jsonl (runtime root is private)`);
  await Bun.write(join(evidenceDir, "identity.json"), JSON.stringify({ mode, runtime: Bun.version, fault: "SIGKILL" }, null, 2));

  let host: Host | undefined;
  let finalCapture: (() => Promise<unknown>) | undefined;
  let worker: Receipt | undefined;
  let workerData: string | undefined;
  let child: Receipt | undefined;
  const result: Record<string, unknown> = { mode };

  try {
    await bounded((async () => {
      host = await startHost();
      finalCapture = async () => Bun.write(join(evidenceDir, "final-native.json"), JSON.stringify(await host!.snapshot(), null, 2));
      phase = "signup";
      const cookie = { value: "" };
      await signUp(host, cookie);
      let transport = transportFor(host, cookie);
      const { workspace, deployed } = await deployProjectWorkflow(host, cookie);
      transport = transportFor(host, cookie);

      phase = "trigger";
      const payload = initPayload(workspace.principalId);
      const fired = await triggerWorkflowRun(transport, workspace.tenantId, deployed.id, { content: JSON.stringify(payload) });
      const activeRunId = fired.runId;
      const capture = async (label: string) => {
        const events = await readTopEvents(transport, workspace.tenantId, deployed.id, activeRunId);
        await Bun.write(join(evidenceDir, `${label}.json`), JSON.stringify({
          mode, label, deploymentId: deployed.id, runId: activeRunId, tenantId: workspace.tenantId,
          runCompletedCount: runCompletedCount(events), stepExecutionCounts: stepExecutionCounts(events),
          events: eventSummary(events),
        }, null, 2));
        return events;
      };
      finalCapture = () => capture("final");

      let signalCount = 0;
      const decisionSignal = (decision: Record<string, unknown>): Signal => {
        signalCount += 1;
        return { runId: activeRunId, signalName: SIGNAL_NAME, signalId: `decision-${signalCount}`, payload: { principalId: workspace.principalId, decision } };
      };

      await pollUntilParked(transport, workspace.tenantId, deployed.id, activeRunId);
      phase = "signal-1";
      // open_review never sets `done`, so it is the idempotency check's
      // target too -- the run stays live for both idempotency checks below
      // without needing a prior approve.
      const firstSignal = decisionSignal(openReview("d1-open-1", 1, STAGE1_ARTIFACT, 1, SHA.stage1v1));
      await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, firstSignal);

      if (mode === "idempotency") {
        // Test against decision-1 (open_review stage 1): it never sets
        // `done`, so it stays live for both idempotency checks -- the run
        // must NOT be terminal yet, or a different-payload retry would
        // surface "workflow_run_not_running" instead of the dedicated
        // signal_id_conflict code this test targets.
        const before = await bounded((async () => {
          const events = await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
          return capture("before-idempotency").then(() => events);
        })(), scenario);
        const iterationsBefore = await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId);

        // Re-POST the identical signalId+payload: must not create a second iteration or decision.
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, firstSignal);
        const after = await capture("after-idempotency-same-payload");
        const iterationsAfterSame = await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId);
        assertNoReplay(before, after, ["init"]);
        result["idempotencySamePayload"] = { iterationsBefore, iterationsAfterSame };

        // Same signalId, DIFFERENT payload, run still live: must be a 409
        // signal_id_conflict, and must not touch the committed state.
        let rejected = false;
        let status: number | undefined;
        let code: string | undefined;
        const differentPayload: Signal = {
          runId: activeRunId, signalName: SIGNAL_NAME, signalId: firstSignal.signalId,
          payload: { principalId: workspace.principalId, decision: sendBack("d1-open-1", 1, 1, "different") },
        };
        try {
          await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, differentPayload);
        } catch (error) {
          rejected = true;
          status = error instanceof ApiError ? error.status : undefined;
          code = error instanceof ApiError ? error.code : undefined;
        }
        const afterConflict = await capture("after-idempotency-different-payload");
        assertNoReplay(after, afterConflict, ["init"]);
        result["idempotencyDifferentPayload"] = { rejected, status, code };
        if (!rejected || status !== 409 || code !== "signal_id_conflict") throw new ProofFailure("history");
        if (iterationsAfterSame !== iterationsBefore) throw new ProofFailure("history");

        // Now actually finish the project so the scenario ends cleanly.
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d2-approve-1", 1, "stage-1-review-1", STAGE1_ARTIFACT, 1, SHA.stage1v1)));
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(openReview("d3-open-2", 2, STAGE2_ARTIFACT, 1, SHA.stage2v1)));
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d4-approve-2", 2, "stage-2-review-1", STAGE2_ARTIFACT, 1, SHA.stage2v1)));
        const events = await pollUntilCompleted(transport, workspace.tenantId, deployed.id, activeRunId);
        await capture("final");
        result["runCompletedCount"] = runCompletedCount(events);
        console.log(`PASS idempotency: same signalId+payload produced no second iteration (iterations stayed at ${String(iterationsBefore)})`);
        console.log("PASS idempotency: same signalId with a different payload was rejected 409 signal_id_conflict, state unchanged");
        return;
      }

      if (mode === "host-restart" || mode === "run-child-loss") {
        // open_review(1)->approve(1)->open_review(2), then send_back 2 -> 1
        // while parked at stage 2, then fault while parked again at stage 1
        // (inside the resumed loop iteration).
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d2-approve-1", 1, "stage-1-review-1", STAGE1_ARTIFACT, 1, SHA.stage1v1)));
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(openReview("d3-open-2", 2, STAGE2_ARTIFACT, 1, SHA.stage2v1)));
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(sendBack("d4-send-back", 2, 1, "needs rework")));
        const before = await bounded((async () => {
          const events = await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
          return capture("before-fault").then(() => events);
        })(), scenario);
        phase = "before-fault";
        const iterationsBeforeFault = await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId);
        const priorIterationRuns = iterationRunIds(await listWorkflowRuns(transport, workspace.tenantId, activeRunId), activeRunId);
        const priorApply = applyStepOutputFrom(await readTopEvents(transport, workspace.tenantId, deployed.id, priorIterationRuns[priorIterationRuns.length - 2]!));
        if (priorApply?.stage !== 1 || priorApply.reviews["2"]?.status !== "stale" || priorApply.reviews["1"]?.status !== "stale") throw new ProofFailure("history");
        result["sendBackApplied"] = { stage: priorApply.stage, stage1ReviewStatus: priorApply.reviews["1"]?.status, stage2ReviewStatus: priorApply.reviews["2"]?.status };
        if (process.env["PROOF_DEBUG"]) {
          console.error("iterations before fault:", iterationsBeforeFault);
          console.error("runs:", await listWorkflowRuns(transport, workspace.tenantId, activeRunId));
        }

        const allocation = allocationIdentity(await host!.snapshot(), deployed.id);
        workerData = join(dataDir, "hub/process-provisioner/allocations", allocation.id, `gen-${allocation.generation}`, "data");
        const pid = Number(await Bun.file(join(workerData, "../sidecar.pid")).text());
        const workerCandidate = await receiptFor(dataDir, pid);
        verifyIdentity(workerCandidate, inspectProcess(pid), { entry: workerEntry, data: workerData, parent: host!.process.pid });
        worker = workerCandidate;
        const childEntry = join(root, "vendor/interchange/apps/sidecar/bin/workflow-child");
        const children = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid)], { timeout: 2000 });
        if (children.exitCode !== 0) throw new ProofFailure("ownership");
        const candidates: Receipt[] = [];
        for (const childPid of children.stdout.toString().trim().split(/\s+/).map(Number)) {
          const candidate = await receiptFor(dataDir, childPid);
          if (candidate.entry !== childEntry) continue;
          verifyIdentity(candidate, inspectProcess(childPid), { entry: childEntry, parent: pid });
          candidates.push(candidate);
        }
        if (candidates.length !== 1) throw new ProofFailure("ownership");
        child = candidates[0]!;

        if (mode === "host-restart") {
          phase = "fault";
          verifyIdentity(host!.identity, inspectProcess(host!.process.pid), { entry, parent: globalThis.process.pid });
          host!.process.kill("SIGKILL");
          host!.process.disconnect();
          await bounded(host!.process.exited, AbortSignal.timeout(5000));
          host = await startHost();
          transport = transportFor(host, cookie);
        } else {
          phase = "fault";
          verifyIdentity(child, inspectProcess(child.pid), { entry: childEntry, parent: pid });
          await Bun.write(join(evidenceDir, "fault.json"), JSON.stringify({ mode, sidecarPid: pid, targetPid: child.pid, signal: "SIGKILL" }));
          globalThis.process.kill(child.pid, "SIGKILL");
        }
        await capture("after-fault");

        phase = "recovery";
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        // Stage 1's review is stale after the send-back (even though it was
        // already approved once) -- a fresh open_review is required before
        // reapproving.
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(openReview("d5-open-1-again", 1, STAGE1_ARTIFACT, 2, SHA.stage1v2)));
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d6-reapprove-1", 1, "stage-1-review-2", STAGE1_ARTIFACT, 2, SHA.stage1v2)));
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(openReview("d7-open-2-again", 2, STAGE2_ARTIFACT, 2, SHA.stage2v2)));
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d8-approve-2", 2, "stage-2-review-2", STAGE2_ARTIFACT, 2, SHA.stage2v2)));
        if (process.env["PROOF_DEBUG"]) {
          console.error("iterations after recovery signals:", await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId));
          console.error("runs after recovery:", await listWorkflowRuns(transport, workspace.tenantId, activeRunId));
          const runs = await listWorkflowRuns(transport, workspace.tenantId, activeRunId);
          for (const runId of runs) {
            console.error(runId, JSON.stringify(await readTopEvents(transport, workspace.tenantId, deployed.id, runId)));
          }
        }
        const events = await pollUntilCompleted(transport, workspace.tenantId, deployed.id, activeRunId);
        const after = await capture("after-recovery");
        const finalState = finalStateFrom(events);
        // "init" and every step completed strictly before the fault must not
        // have re-executed; the loop container itself completes exactly once,
        // at the very end, so it is excluded from this per-step replay check.
        assertNoReplay(before, after, ["init"]);
        result["runCompletedCount"] = runCompletedCount(events);
        result["iterations"] = await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId);
        result["signalsDelivered"] = signalCount;
        result["finalState"] = finalState;
        if (runCompletedCount(events) !== 1) throw new ProofFailure("history");
        if (!finalState?.done) throw new ProofFailure("history");
        console.log(`PASS ${mode}: exactly one RunCompleted; carried state survived the fault; no pre-fault step replayed`);
        return;
      }

      // mode === "full" (S1). The real signal route stamps `principalId` from
      // the AUTHENTICATED caller and ignores any value in the payload (see
      // vendor/interchange/packages/hub-api/src/routes/workflows.ts:492), and
      // this proof signs up exactly one account -- so an "unauthorized"
      // refusal cannot be exercised here without a second real grant-bearing
      // principal. That path is already fully covered by the in-process
      // proof (scripts/project-workflow-proof-local.ts), with a directly
      // controlled principalId; here we exercise every OTHER refusal reason
      // over the real deploy+signal route instead.
      // approve(1), then open_review(2), then every refusal reason at stage 2.
      await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
      await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d2-approve-1", 1, "stage-1-review-1", STAGE1_ARTIFACT, 1, SHA.stage1v1)));
      await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
      await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(openReview("d3-open-2", 2, STAGE2_ARTIFACT, 1, SHA.stage2v1)));
      await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);

      const refusals: Record<string, unknown>[] = [
        approve("d4-stale-review", 2, "stale-review-id", STAGE2_ARTIFACT, 1, SHA.stage2v1),
        approve("d5-stale-version", 2, "stage-2-review-1", STAGE2_ARTIFACT, 99, SHA.stage2v1),
        approve("d6-hash-mismatch", 2, "stage-2-review-1", STAGE2_ARTIFACT, 1, "sha-fixture-wrong"),
        approve("d7-wrong-project", 2, "stage-2-review-1", STAGE2_ARTIFACT, 1, SHA.stage2v1, { projectId: "not-this-project" }),
      ];
      for (const decision of refusals) {
        signalCount += 1;
        await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, {
          runId: activeRunId, signalName: SIGNAL_NAME, signalId: `decision-${signalCount}`,
          payload: { principalId: workspace.principalId, decision },
        });
        await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
      }
      // Duplicate decisionId (reuses "d1-open-1"): must not re-iterate as a
      // logical decision.
      signalCount += 1;
      await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, {
        runId: activeRunId, signalName: SIGNAL_NAME, signalId: `decision-${signalCount}`,
        payload: { principalId: workspace.principalId, decision: approve("d1-open-1", 2, "stage-2-review-1", STAGE2_ARTIFACT, 1, SHA.stage2v1) },
      });
      await waitForIterationParked(transport, workspace.tenantId, deployed.id, activeRunId, signalCount + 1);
      await deliverWorkflowSignal(transport, workspace.tenantId, deployed.id, decisionSignal(approve("d9-approve-2", 2, "stage-2-review-1", STAGE2_ARTIFACT, 1, SHA.stage2v1)));
      const events = await pollUntilCompleted(transport, workspace.tenantId, deployed.id, activeRunId);
      await capture("final");
      const finalState = finalStateFrom(events);
      const iterations = await iterationCount(transport, workspace.tenantId, deployed.id, activeRunId);
      result["runCompletedCount"] = runCompletedCount(events);
      result["iterations"] = iterations;
      result["signalsDelivered"] = signalCount;
      result["finalState"] = finalState;
      if (runCompletedCount(events) !== 1) throw new ProofFailure("history");
      if (iterations !== signalCount) throw new ProofFailure("history");
      if (!finalState?.done) throw new ProofFailure("history");
      const decisions = finalState.decisions as { decisionId: string; accepted: boolean }[];
      for (const id of ["d4-stale-review", "d5-stale-version", "d6-hash-mismatch", "d7-wrong-project"]) {
        const record = decisions.find((d) => d.decisionId === id);
        if (!record || record.accepted !== false) throw new ProofFailure("history");
      }
      if (decisions.filter((d) => d.decisionId === "d1-open-1").length !== 2) throw new ProofFailure("history");
      result["refusalsVerified"] = ["d4-stale-review", "d5-stale-version", "d6-hash-mismatch", "d7-wrong-project", "duplicate-d1-open-1"];
      console.log(`PASS ${mode}: exactly one RunCompleted; iterations (${String(iterations)}) == signals delivered (${String(signalCount)}); 4 refusals + duplicate collapsed verified`);
    })(), scenario);
  } finally {
    console.log(`RESULT ${JSON.stringify(result)}`);
    await Bun.write(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
    if (finalCapture) await bounded(finalCapture(), AbortSignal.timeout(20_000)).catch(() => Bun.write(join(evidenceDir, "final-unavailable.json"), JSON.stringify({ category: "final_capture_unavailable" })));
    if (host) {
      const stopping = host.process;
      if (stopping.exitCode === null) {
        verifyIdentity(host.identity, inspectProcess(stopping.pid), { entry, parent: globalThis.process.pid });
        stopping.kill("SIGKILL");
      }
      stopping.disconnect();
      await bounded(stopping.exited, AbortSignal.timeout(5000)).catch(() => undefined);
    }
    await cleanupDescendants(dataDir, hostPids, workerEntry, childEntries);
    await host?.closeReaders();
    void worker;
    void workerData;
    void child;
    // Evidence is sanitized JSON only; nothing else in the temp root is kept.
    if (!process.env["PROOF_DEBUG"]) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const requestedModes = process.env["PROOF_MODES"]?.split(",") ?? ["full", "idempotency", "host-restart", "run-child-loss"];
let failed = false;
for (const mode of requestedModes as ("full" | "idempotency" | "host-restart" | "run-child-loss")[]) {
  try {
    await runScenario(mode);
  } catch (error) {
    failed = true;
    const outcome = { mode, phase, ...safeFailure(error), message: error instanceof Error ? error.message : String(error) };
    console.error(JSON.stringify(outcome));
    if (process.env["PROOF_DEBUG"]) console.error(error);
    if (scenario.aborted) break;
  }
}
if (failed) process.exitCode = 1;
