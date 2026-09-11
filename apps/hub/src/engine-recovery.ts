/**
 * Recovery from a host restart: the executor's run map is in memory, so a
 * restart mid-flight loses it. Relaunching is idempotent, and doing it right
 * before a gate signal — rather than only at project creation — is what
 * keeps the runtime alive across a closed window.
 *
 * Nothing here writes run state; `hasExecution`/`launchProjectLifecycle`/
 * `deliverStageSignal` all live in the executor itself.
 */
import { LEDGER, type Command, type Stage } from "@solutions-builder/app/ledger";
import {
  alignRunWithLedger,
  deliverStageSignal,
  hasExecution,
  launchProjectLifecycle,
  type DeliveryOutcome,
} from "./hub-executor.js";
import type { LedgerPosition } from "@solutions-builder/app/workflows/stage-loop";
import type { CommandInput } from "./engine.js";

/** The run's stage and state before the command, as the engine read them. */
export type RunBefore = { readonly stage: Stage; readonly state: string };

/**
 * The commands that correspond to a stage gate — the ones `stage-loop.ts`
 * models as a signal a stage's run waits on. Committing one of these is what
 * "the platform run advances" means for this pass, so it is the one place
 * that talks to the runtime executor.
 */
export const GATE_COMMANDS: readonly Command[] = [
  ...new Set(LEDGER.filter((row) => row.from?.kind === "stage").map((row) => row.command)),
];

/**
 * Best-effort shadow of a committed gate transition: relaunches the
 * project's run if the executor lost it to a restart, then delivers the
 * stage signal. Called outside the transaction that committed the
 * transition — the executor is not something the database's single writer
 * connection can be reached from mid-transaction, and this is not part of
 * what made the transition valid.
 *
 * Returns the delivery outcome so a caller that needs the round to have
 * actually reached a waiting run (a drafting request) can tell "delivered"
 * from "nothing was there to hear it" rather than assuming the best;
 * `undefined` for a command that is not a gate at all.
 */
export async function runGateSideEffects(input: CommandInput, before?: RunBefore): Promise<DeliveryOutcome | undefined> {
  if (!GATE_COMMANDS.includes(input.type)) return undefined;

  // The command acted on a stage and a state the ledger recorded; the run
  // has to be parked there for the signal to mean anything. It may not be:
  // a fresh run after the definition changed starts at stage 1, and a
  // project from before the specialists lived in the run has no run at all.
  // So the run is brought to the ledger first, and the command is delivered
  // to that stage and no other.
  const position: LedgerPosition | null =
    before && (before.state === "in_progress" || before.state === "waiting_approval")
      ? { stage: before.stage, state: before.state }
      : null;
  if (position) {
    const aligned = await alignRunWithLedger(input.projectId, position).catch((cause: unknown) => {
      console.error(`[executor] ${input.projectId}: could not bring the run to the ledger:`, cause);
      return "failed" as const;
    });
    if (aligned !== "aligned") return aligned;
  } else if (!hasExecution(input.projectId)) {
    // A restart empties the executor's map, so a project mid-flight has no
    // live run and every later gate would no-op in silence. Relaunching is
    // idempotent, and doing it here rather than only at creation is what
    // makes the runtime survive the window being closed.
    await launchProjectLifecycle({
      projectId: input.projectId,
    }).catch((cause: unknown) => {
      console.error(`[executor] ${input.projectId}: could not relaunch after restart:`, cause);
    });
  }
  return deliverStageSignal(input.projectId, input.type, input.payload, input.idempotencyKey, position?.stage).catch(
    (cause: unknown): DeliveryOutcome => {
      console.error(`[executor] ${input.projectId}: signal delivery threw:`, cause);
      return "failed";
    },
  );
}
