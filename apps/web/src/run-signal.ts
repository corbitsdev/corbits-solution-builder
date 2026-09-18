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
import {
  deliverWorkflowSignal,
  findAwaitingSignal,
  listWorkflowRuns,
  readWorkflowRunEvents,
  triggerWorkflowRun,
  type Transport,
  type WorkflowRunTrigger,
} from "@intx/hub-client";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { positionOfSignal, stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import type { Anchor, Direction } from "@solutions-builder/app/design-prompt";
import { createHubTransport } from "./hub.ts";
import { foldProject, type StageStatus } from "./run-fold.ts";

/** How long to wait for a loop's child iteration to arm its awaiter before giving up and sending anyway. */
const SIGNAL_ARM_TIMEOUT_MS = 20_000;
const SIGNAL_ARM_POLL_MS = 300;

/**
 * Waits until some run under the anchor (the anchor itself, or a loop's
 * current child iteration) has an unresolved `SignalAwaited` for exactly
 * `signalName`, so a signal sent right after is relayed instead of landing
 * before the awaiter is armed and being lost on the runtime's container
 * relay (`driveContainerSignalRelayAwait` in the vendored
 * `packages/workflow/src/runtime/run.ts`). Best-effort: returns `false` on
 * timeout rather than blocking a delivery forever, since the caller may be
 * signaling a run this helper cannot see into (e.g. it isn't in a loop).
 */
export async function awaitSignalArmed(
  tenantId: string,
  anchorRunId: string,
  signalName: string,
  transport: Transport = createHubTransport(),
  timeoutMs: number = SIGNAL_ARM_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
    for (const runId of runIds) {
      const { events } = await readWorkflowRunEvents(transport, tenantId, anchorRunId, runId);
      if (findAwaitingSignal(events)?.signalName === signalName) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SIGNAL_ARM_POLL_MS));
  }
}

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
export async function signalIdFor(anchorRunId: string, signalName: string, intent: unknown): Promise<string> {
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
  await awaitSignalArmed(project.tenantId, project.anchorRunId, signalName, transport);
  await signalRun(
    { tenantId: project.tenantId, anchorRunId: project.anchorRunId, signalName, signalId, payload: intent },
    transport,
  );
  return { signalName, signalId };
}

/**
 * The output cap a round carries when nothing more specific applies. Matches
 * the designer settings' own default (`DESIGNER_TOKENS_DEFAULT` in
 * `apps/hub/src/designer-settings.ts`) and the web settings page's own
 * `TOKENS_DEFAULT` (`apps/web/src/pages/settings.tsx`).
 */
export const DRAFT_MAX_TOKENS_DEFAULT = 32_000;

/**
 * A person's turn inside a stage — a draft/interview reply, a stage 5
 * audience pick, a stage 6 document pick, stage 4 design feedback, or a
 * stage 8 build command: a signed conversation message to the project's run,
 * not a signal. The body is this intent, JSON-encoded, the same convention
 * `createProject`'s own trigger uses (`client.ts`). The run's specialist for
 * the stage consumes it as its next turn and replies by mail; see
 * `apps/web/src/stage-thread.ts` for how both are read back out of the
 * person's own mailbox.
 */
export type StageMailIntent = {
  readonly stage: number;
  readonly command: Command;
  readonly runId: string;
  readonly message?: string;
  readonly quotes?: readonly { readonly quote: string }[];
  readonly inference?: { readonly maxTokens: number };
  /** Stage 5: write these stakeholders' packages only, by name. */
  readonly audiences?: readonly string[];
  /** Stage 6: write the requirements, the plan, or both. */
  readonly documents?: readonly string[];
  /**
   * Stage 4: the design feedback this round's prompt was built from. Carried
   * alongside the deterministic prompt so the feedback thread can be folded
   * back out of the mailbox.
   */
  readonly feedback?: {
    readonly designNodeId: string;
    readonly direction: Direction;
    readonly overallNote: string;
    readonly comments: readonly { readonly anchor: Anchor; readonly body: string }[];
  };
  readonly [key: string]: unknown;
};

/**
 * Sends a person's turn to a stage's run as conversation mail. The trigger
 * route only signs and delivers to the run; it files no Sent copy (unlike
 * `@corbits/mailbox`'s own `/me/inbox/send`, which always files one
 * regardless of delivery). Mirror one here so the person's own turns are
 * readable back out of the SAME thread the specialist's reply lands in
 * (`apps/web/src/stage-thread.ts`'s mailbox fold). Best-effort: the run was
 * already messaged above, so a mirror failure must not look like the message
 * itself failed.
 */
export async function sendStageMail(
  project: Anchored,
  intent: StageMailIntent,
  transport: Transport = createHubTransport(),
): Promise<WorkflowRunTrigger> {
  if (project.anchorRunId === null) {
    throw new Error("This project's lifecycle is not placed on a run yet, so there is no specialist to message.");
  }
  const content = JSON.stringify(intent);
  const trigger = await triggerWorkflowRun(transport, project.tenantId, project.anchorRunId, { content });
  await transport
    .fetch("POST", "/api/me/inbox/send", { to: [trigger.address], subject: intent.command, body: content })
    .catch(() => {});
  return trigger;
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
