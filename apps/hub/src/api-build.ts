/**
 * The build lane's routes: which worker stage 8 runs and whether it is
 * here, and the attempts the bounded bridge drives for a project.
 *
 *   GET  /build/worker                         the choice, every worker, and
 *                                              whether the chosen one is on
 *                                              this host — with how to get it
 *                                              when it is not
 *   PUT  /build/worker                         save the choice or the path
 *   GET  /projects/:id/build/attempts          every attempt and its state
 *   POST /projects/:id/build/attempts          start one (optionally from an
 *                                              earlier attempt's workspace)
 *   GET  /projects/:id/build/attempts/:n       one attempt, its log and prompt
 *   POST /projects/:id/build/attempts/:n/cancel
 *   POST /projects/:id/build/attempts/:n/package
 *                                              archive, hash and probe the
 *                                              attempt; the bytes come back
 *                                              inline for the client to record
 *
 * Nothing here decides what an attempt's outcome means. The worker's final
 * text and exit status are reported as they are; a person, and the stage's
 * reviewing specialist, read them.
 */
import type { Hono } from "hono";
import { type } from "arktype";
import { HostError, projectTenantExists } from "@corbits/embedded-host";
import { attemptVariant, packageAttempt, parseTargetProbe, type TargetProbe } from "@solutions-builder/tools-delivery/publish-workspace";
import { BRIDGE_CAPABILITIES, BRIDGE_ID, bridgeAvailable } from "./corbits-exec.js";
import { BUILD_WORKERS, buildWorkerSettings, hostPlatform, saveBuildWorkerSettings } from "./build-worker.js";
import {
  attemptLog,
  attemptPrompt,
  attemptRecord,
  attemptWorkspace,
  cancelBuildAttempt,
  listAttempts,
  startBuildAttempt,
} from "./build-attempts.js";

/** The hub's binary create route's own ceiling, which the client's write then meets. */
const HOST_PACKAGE_MAX_BYTES = 10 * 1024 * 1024;

const WorkerPatch = type({
  "worker?": "'corbits-code' | 'claude-code' | 'codex'",
  "executable?": "string",
});

const StartBody = type({
  prompt: {
    planText: "string",
    requirementsText: "string",
    designText: "string",
    stackBlock: "string",
    target: "string",
    planRef: "string",
  },
  "continueFrom?": "number",
});

const PackageBody = type({
  "fileName?": "string",
  "targets?": "unknown[]",
});

function parsed<T>(result: T | type.errors): T {
  if (result instanceof type.errors) throw new HostError("validation_failed", result.summary);
  return result;
}

/**
 * The project the route names, checked to exist before anything is read or
 * written under its id: the attempts live on disk under `builds/<id>/`, and
 * an id that is nobody's project must not grow a directory there.
 */
async function projectParam(context: { req: { param: (name: "id") => string } }): Promise<string> {
  const projectId = context.req.param("id");
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new HostError("validation_failed", "That is not a project id.");
  if (!(await projectTenantExists(projectId))) throw new HostError("not_found", "That project was not found.");
  return projectId;
}

function attemptParam(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new HostError("validation_failed", "An attempt is numbered.");
  return Number(raw);
}

/** What `/build/worker` answers: the same shape before and after a save. */
async function workerStatus() {
  const [settings, availability] = await Promise.all([buildWorkerSettings(), bridgeAvailable()]);
  return {
    bridge: BRIDGE_ID,
    capabilities: BRIDGE_CAPABILITIES,
    platform: hostPlatform(),
    settings,
    worker: { id: availability.worker.id, label: availability.worker.label, command: availability.worker.command },
    workers: BUILD_WORKERS.map((entry) => ({ id: entry.id, label: entry.label, executable: entry.executable })),
    available: availability.available,
    detail: availability.detail,
    install: availability.install,
    checkedAt: new Date().toISOString(),
  };
}

export function registerBuildRoutes(api: Hono) {
  api.get("/build/worker", async (context) => context.json(await workerStatus()));

  api.put("/build/worker", async (context) => {
    const patch = parsed(WorkerPatch(await context.req.json().catch(() => ({}))));
    await saveBuildWorkerSettings(patch);
    return context.json(await workerStatus());
  });

  api.get("/projects/:id/build/attempts", async (context) => {
    return context.json({ attempts: await listAttempts(await projectParam(context)) });
  });

  api.post("/projects/:id/build/attempts", async (context) => {
    const projectId = await projectParam(context);
    const body = parsed(StartBody(await context.req.json().catch(() => ({}))));
    const started = await startBuildAttempt({
      projectId,
      prompt: { ...body.prompt, continuing: body.continueFrom !== undefined },
      continueFrom: body.continueFrom,
    });
    return context.json({ attempt: started }, 201);
  });

  api.get("/projects/:id/build/attempts/:n", async (context) => {
    const projectId = await projectParam(context);
    const attempt = attemptParam(context.req.param("n"));
    const record = await attemptRecord(projectId, attempt);
    if (!record) throw new HostError("not_found", `Attempt ${String(attempt)} was not found.`);
    const [log, prompt] = await Promise.all([attemptLog(projectId, attempt), attemptPrompt(projectId, attempt)]);
    return context.json({ attempt: record, log, prompt });
  });

  api.post("/projects/:id/build/attempts/:n/cancel", async (context) => {
    const projectId = await projectParam(context);
    const attempt = attemptParam(context.req.param("n"));
    const record = await attemptRecord(projectId, attempt);
    if (!record) throw new HostError("not_found", `Attempt ${String(attempt)} was not found.`);
    const cancelled = await cancelBuildAttempt(projectId, attempt);
    if (!cancelled) {
      throw new HostError("conflict", `Attempt ${String(attempt)} is not running on this host (${record.state}).`, {}, false);
    }
    return context.json({ ok: true });
  });

  api.post("/projects/:id/build/attempts/:n/package", async (context) => {
    const projectId = await projectParam(context);
    const attempt = attemptParam(context.req.param("n"));
    const record = await attemptRecord(projectId, attempt);
    if (!record) throw new HostError("not_found", `Attempt ${String(attempt)} was not found.`);
    if (record.state === "running") {
      throw new HostError("conflict", "The worker has not ended. Its work can be packaged once it has.", {}, false);
    }
    const body = parsed(PackageBody(await context.req.json().catch(() => ({}))));
    const targets = (body.targets ?? []).map(parseTargetProbe).filter((probe): probe is TargetProbe => probe !== null);
    try {
      const packaged = await packageAttempt({
        dir: attemptWorkspace(projectId, attempt),
        attempt: attemptVariant(`attempts/${String(attempt)}`),
        ...(body.fileName ? { fileName: body.fileName } : {}),
        targets,
        maxBytes: HOST_PACKAGE_MAX_BYTES,
        // A person's own start command, run here on the host: the manifest says so.
        ranOn: "host",
      });
      return context.json({ packaged });
    } catch (cause) {
      throw new HostError("conflict", cause instanceof Error ? cause.message : String(cause), {}, false);
    }
  });
}
