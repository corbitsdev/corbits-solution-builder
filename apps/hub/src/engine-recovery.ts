/**
 * Recovery from a host restart: the executor's run map is in memory, so a
 * restart mid-flight loses it. Relaunching is idempotent, and doing it right
 * before a gate signal — rather than only at project creation — is what
 * keeps the runtime alive across a closed window.
 *
 * Nothing here writes run state; `hasExecution`/`launchProjectLifecycle`/
 * `deliverStageSignal` all live in the executor itself.
 */
import type { Command } from "@solutions-builder/app/ledger";
import {
  deliverStageSignal,
  hasExecution,
  launchProjectLifecycle,
} from "./hub-executor.js";
import type { CommandInput } from "./engine.js";

/**
 * The commands that correspond to a stage gate — the ones `stage-loop.ts`
 * models as a signal a stage's run waits on. Committing one of these is what
 * "the platform run advances" means for this pass, so it is the one place
 * that talks to the runtime executor.
 */
export const GATE_COMMANDS: readonly Command[] = [
  "stage.approve",
  "stage.reject",
  "stage.revise",
  "stage.route_back",
];

/**
 * Best-effort shadow of a committed gate transition: relaunches the
 * project's run if the executor lost it to a restart, then delivers the
 * stage signal. Called outside the transaction that committed the
 * transition — the executor is not something the database's single writer
 * connection can be reached from mid-transaction, and this is not part of
 * what made the transition valid.
 */
export async function runGateSideEffects(input: CommandInput): Promise<void> {
  if (!GATE_COMMANDS.includes(input.type)) return;

  // A restart empties the executor's map, so a project mid-flight has no
  // live run and every later gate would no-op in silence. Relaunching is
  // idempotent, and doing it here rather than only at creation is what
  // makes the runtime survive the window being closed.
  if (!hasExecution(input.projectId)) {
    await launchProjectLifecycle({
      projectId: input.projectId,
      branchId: String(input.payload.branchId ?? ""),
    }).catch((cause: unknown) => {
      console.error(`[executor] ${input.projectId}: could not relaunch after restart:`, cause);
    });
  }
  await deliverStageSignal(input.projectId, input.type, input.payload).catch((cause: unknown) => {
    console.error(`[executor] ${input.projectId}: signal delivery threw:`, cause);
  });
}
