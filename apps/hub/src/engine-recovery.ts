/**
 * Recovery from a host restart: the executor's run map is in memory, so a
 * restart mid-flight loses it. Relaunching is idempotent, and doing it right
 * before a gate signal — rather than only at project creation — is what
 * keeps the runtime alive across a closed window.
 *
 * Nothing here writes run state; `hasExecution`/`launchProjectLifecycle`/
 * `deliverStageSignal` all live in the executor itself.
 */
import { LEDGER, type Command } from "@solutions-builder/app/ledger";
import {
  deliverStageSignal,
  hasExecution,
  launchProjectLifecycle,
  type DeliveryOutcome,
} from "./hub-executor.js";
import type { CommandInput } from "./engine.js";

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
export async function runGateSideEffects(input: CommandInput): Promise<DeliveryOutcome | undefined> {
  if (!GATE_COMMANDS.includes(input.type)) return undefined;

  // A restart empties the executor's map, so a project mid-flight has no
  // live run and every later gate would no-op in silence. Relaunching is
  // idempotent, and doing it here rather than only at creation is what
  // makes the runtime survive the window being closed.
  if (!hasExecution(input.projectId)) {
    await launchProjectLifecycle({
      projectId: input.projectId,
    }).catch((cause: unknown) => {
      console.error(`[executor] ${input.projectId}: could not relaunch after restart:`, cause);
    });
  }
  return deliverStageSignal(input.projectId, input.type, input.payload, input.idempotencyKey).catch(
    (cause: unknown): DeliveryOutcome => {
      console.error(`[executor] ${input.projectId}: signal delivery threw:`, cause);
      return "failed";
    },
  );
}
