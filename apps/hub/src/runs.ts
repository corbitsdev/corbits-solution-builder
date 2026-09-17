/**
 * A project's runs, derived from the ledger thread.
 *
 * Every committed command carries the run mutations it caused (`runs` on its
 * ledger turn): a run opened, a run patched. Folding those in order is the
 * run record — there is no table and no process memory holding a second copy.
 * Where the run actually stands in the runtime is the hub's own workflow run
 * (`hub-executor.ts`); what the product knows about it (origin, source, the
 * cost approval it carries, its packet, its checkpoint, why it ended) is here.
 */
import { eq } from "drizzle-orm";
import type { RunKind, RunState, Stage } from "@solutions-builder/app/ledger";
import { database } from "./db.js";
import * as table from "./schema.js";
import { ledgerCommands } from "./engine-ledger.js";
import { readProject } from "./installer-bridge.js";

export type RunRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly kind: RunKind;
  readonly stage: Stage;
  readonly state: RunState;
  readonly sourceRunId: string | null;
  readonly originId: string;
  readonly terminalReason: string | null;
  readonly costApprovalVersionId: string | null;
  readonly routeTargetStage: number | null;
  readonly packetId: string | null;
  readonly checkpointRef: string | null;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
};

export type RunPatch = Partial<Omit<RunRecord, "id" | "projectId" | "createdAt">>;

/** One change to the run set, recorded on the command that caused it. */
export type RunMutation =
  | { readonly op: "create"; readonly run: RunRecord }
  | { readonly op: "patch"; readonly runId: string; readonly patch: RunPatch };

/**
 * The run mutations a command wants to make, collected while the transaction
 * runs and written to the ledger after it commits. Reads see the draft first,
 * so a command that opens a run and then patches it works on its own change.
 */
export class RunDraft {
  readonly mutations: RunMutation[] = [];
  private readonly runs: Map<string, RunRecord>;

  constructor(current: readonly RunRecord[]) {
    this.runs = new Map(current.map((run) => [run.id, run]));
  }

  create(run: RunRecord): string {
    this.runs.set(run.id, run);
    this.mutations.push({ op: "create", run });
    return run.id;
  }

  patch(runId: string, patch: RunPatch): void {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`runs: no run ${runId} to patch`);
    this.runs.set(runId, { ...existing, ...patch });
    this.mutations.push({ op: "patch", runId, patch });
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }
}

type Wire = Record<string, unknown>;

function dateOf(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function reviveRun(wire: Wire): RunRecord {
  return {
    ...(wire as unknown as RunRecord),
    createdAt: dateOf(wire.createdAt) ?? new Date(0),
    endedAt: dateOf(wire.endedAt),
  };
}

function revivePatch(wire: Wire): RunPatch {
  const patch: Record<string, unknown> = { ...wire };
  if ("endedAt" in wire) patch.endedAt = dateOf(wire.endedAt);
  return patch as RunPatch;
}

/**
 * The run a project had before its ledger carried run mutations: recovered
 * from what is durable — the furthest stage that produced a document, and
 * whether the last committed command parked it on a person. Deterministic in
 * the project id so a command aimed at it can be recorded against it.
 */
const PARKED_BY: Record<string, { state: RunState; stage: Stage }> = {
  "stage.submit": { state: "waiting_approval", stage: 1 },
  "cost.approve": { state: "cost_approved", stage: 7 },
  "build.wait_for_human": { state: "waiting_human", stage: 8 },
  "build.accept_evidence": { state: "delivery_review", stage: 9 },
};

export function legacyRunId(projectId: string): string {
  return `lifecycle-${projectId}`;
}

async function legacyRun(projectId: string, lastCommand: string | undefined): Promise<RunRecord | null> {
  const project = await readProject(projectId);
  if (!project) return null;
  const { db } = database();
  const nodes = await db
    .select({ stage: table.artifactNode.stage })
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId));
  const reached = nodes.reduce<number>((high, row) => Math.max(high, row.stage), 1) as Stage;
  const parked = lastCommand ? PARKED_BY[lastCommand] : undefined;
  const id = legacyRunId(projectId);
  return {
    id,
    projectId,
    kind: "stage",
    stage: parked ? (Math.max(reached, parked.stage) as Stage) : reached,
    state: parked?.state ?? "in_progress",
    sourceRunId: null,
    originId: id,
    terminalReason: null,
    costApprovalVersionId: null,
    routeTargetStage: null,
    packetId: null,
    checkpointRef: null,
    createdAt: new Date(project.createdAt),
    endedAt: null,
  };
}

/** Every run of a project, oldest first, folded from the ledger. */
export async function runsForProject(projectId: string): Promise<RunRecord[]> {
  const commands = await ledgerCommands(projectId);
  const runs = new Map<string, RunRecord>();
  let legacy: RunRecord | null | undefined;
  const legacyId = legacyRunId(projectId);
  const lastCommand = commands.at(-1)?.command;

  for (const command of commands) {
    for (const raw of command.runs) {
      const mutation = raw as Wire;
      if (mutation.op === "create") {
        const run = reviveRun(mutation.run as Wire);
        runs.set(run.id, run);
        continue;
      }
      const runId = String(mutation.runId);
      let existing = runs.get(runId);
      if (!existing && runId === legacyId) {
        legacy ??= await legacyRun(projectId, lastCommand);
        if (legacy) {
          runs.set(legacyId, legacy);
          existing = legacy;
        }
      }
      if (existing) runs.set(runId, { ...existing, ...revivePatch(mutation.patch as Wire) });
    }
  }

  if (runs.size === 0) {
    legacy ??= await legacyRun(projectId, lastCommand);
    if (legacy) runs.set(legacy.id, legacy);
  }
  return [...runs.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** The most recent run that has not ended, else the most recent run. */
export async function activeRun(projectId: string): Promise<RunRecord | null> {
  const runs = await runsForProject(projectId);
  return [...runs].reverse().find((run) => run.endedAt === null) ?? runs.at(-1) ?? null;
}

/** A run by id, scoped to its project: a run in another project is not found. */
export async function readRun(runId: string, projectId: string): Promise<RunRecord | null> {
  const runs = await runsForProject(projectId);
  return runs.find((run) => run.id === runId) ?? null;
}
