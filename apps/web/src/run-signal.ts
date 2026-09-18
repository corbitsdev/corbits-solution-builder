/**
 * A person's decision at a gate is a named signal on the project's run.
 *
 * The gate is the platform's: a `wait` step on `stageSignal(stage, command)`.
 * The client delivers to it over `/hub` with the person's own session, so the
 * hub authorizes the `signal:<name>` grant for that principal and refuses
 * anyone else. The body is the thin intent — the command, the run, what was
 * decided and on which versions — never the authority, never a revision, never
 * a tally. The `signalId` is a digest of that intent, so the same click sent
 * twice is the same signal and the runtime deduplicates it; the ledger on the
 * host follows the run on its next read.
 */
import { deliverWorkflowSignal, type Transport } from "@intx/hub-client";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { positionOfSignal, stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { createHubTransport } from "./hub.ts";
import { foldProject, type StageStatus } from "./run-fold.ts";

export async function signalRun(
  args: {
    readonly tenantId: string;
    readonly anchorRunId: string;
    readonly signalName: string;
    readonly signalId: string;
    readonly payload?: unknown;
  },
  transport: Transport = createHubTransport(),
): Promise<void> {
  await deliverWorkflowSignal(transport, args.tenantId, args.anchorRunId, {
    runId: args.anchorRunId,
    signalName: args.signalName,
    signalId: args.signalId,
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
  });
}

export type VersionRef = { readonly artifactId: string; readonly versionId: string; readonly contentHash: string };

/** What a person decided, and nothing about who may. */
export type GateIntent = {
  readonly command: Command;
  readonly runId: string;
  readonly versions?: readonly VersionRef[];
  readonly rationale?: string;
  readonly reason?: string;
  readonly targetStage?: number;
  readonly audienceName?: string;
  readonly decision?: "proceed" | "reject" | "revise";
};

/** The tenant and deployment a project's run lives under, as `GET /projects/:id` names them. */
export type Anchored = { readonly tenantId: string; readonly anchorRunId: string | null };

/**
 * The signal the run awaits for this command at this stage. The name is the
 * ledger's (`stageSignal`); when the fold shows the stage parked on its
 * exhaustion twin, that name is used instead, since the two gates are never
 * live together and only the parked one can hear.
 */
export function gateSignalName(stage: Stage, command: Command, standing: StageStatus | null): string {
  const named = stageSignal(stage, command);
  const parked = standing?.stage === stage && standing.parked ? standing.signalName : null;
  if (parked !== null && positionOfSignal(stage, parked)?.at === positionOfSignal(stage, named.name)?.at) return parked;
  return named.name;
}

/** The same intent on the same gate is the same signal: a retry or a double-click dedups on the runtime. */
export async function signalIdFor(anchorRunId: string, signalName: string, intent: GateIntent): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([anchorRunId, signalName, intent]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Delivered = { readonly signalName: string; readonly signalId: string };

/** Delivers one gate decision to the project's run. */
export async function deliverGate(
  project: Anchored,
  stage: Stage,
  standing: StageStatus | null,
  intent: GateIntent,
  transport: Transport = createHubTransport(),
): Promise<Delivered> {
  if (project.anchorRunId === null) {
    throw new Error("This project's lifecycle is not placed on a run yet, so there is no gate to decide at.");
  }
  const signalName = gateSignalName(stage, intent.command, standing);
  const signalId = await signalIdFor(project.anchorRunId, signalName, intent);
  await signalRun(
    { tenantId: project.tenantId, anchorRunId: project.anchorRunId, signalName, signalId, payload: intent },
    transport,
  );
  return { signalName, signalId };
}

/** The approval that leaves a stage's gate: stage 7 approves a cost, everything before it approves the draft. */
export function approvalCommand(stage: Stage): Command {
  return stage === 7 ? "cost.approve" : "stage.approve";
}

/** How long a submit gets to park the run at its gate before the approval is sent. */
const GATE_PARK_WAIT_MS = 30_000;

/**
 * Submit, then decide: the solo approver's one click, and a stakeholder's
 * first decision at stage 5. Two signals with two ids, the second sent once
 * the fold shows the run parked at the gate; a stage already submitted skips
 * straight to the decision.
 */
export async function submitThen(
  project: Anchored,
  stage: Stage,
  standing: StageStatus | null,
  submit: { readonly runId: string; readonly versions: readonly VersionRef[] },
  then: GateIntent,
  transport: Transport = createHubTransport(),
  fold: (project: Anchored) => Promise<StageStatus | null> = (anchored) =>
    anchored.anchorRunId === null ? Promise.resolve(null) : foldProject(anchored.tenantId, anchored.anchorRunId, transport),
): Promise<Delivered[]> {
  const delivered: Delivered[] = [];
  let parked = standing;
  const atGate = (status: StageStatus | null) =>
    status !== null && status.stage === stage && status.parked && status.signalName !== null &&
    positionOfSignal(stage, status.signalName)?.at === "gate";
  if (!atGate(parked)) {
    delivered.push(await deliverGate(project, stage, parked, { command: "stage.submit", ...submit }, transport));
    const deadline = Date.now() + GATE_PARK_WAIT_MS;
    for (;;) {
      parked = await fold(project);
      if (atGate(parked)) break;
      if (Date.now() >= deadline) {
        throw new Error("The stage was submitted, but its gate has not opened yet. Decide again once it has.");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  delivered.push(await deliverGate(project, stage, parked, then, transport));
  return delivered;
}
