/**
 * Recovery from a host restart, and delivery of a gate command to the run.
 *
 * The executor's run map is in memory, so a restart mid-flight loses it.
 * Relaunching is idempotent, and doing it right before a gate signal —
 * rather than only at project creation — is what keeps the runtime alive
 * across a closed window.
 *
 * A gate command is delivered first: `admitGate` in the app package is the
 * admit authority; this module does not evaluate the ledger. A fresh UUID
 * is the signal id every time, so a refused wait can hear the next
 * delivery instead of treating it as a duplicate of the command's
 * idempotency key.
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
} from "./lifecycle-run.js";
import type { LedgerPosition } from "@solutions-builder/app/workflows/stage-loop";
import type { CommandInput } from "./engine.js";

/** The run's stage and state before the command, as the engine read them. */
export type RunBefore = { readonly stage: Stage; readonly state: string };

/**
 * The commands that correspond to a stage gate — the ones `stage-loop.ts`
 * models as a signal a stage's run waits on — plus accept/fail, which park
 * after the build agent on the evidence signal, not on gate-8, while the
 * iteration is live. Committing one of these is what "the platform run
 * advances" means for this pass, so it is the one place that talks to the
 * runtime executor.
 */
export const GATE_COMMANDS: readonly Command[] = [
  ...new Set<Command>([
    ...LEDGER.filter((row) => row.from?.kind === "stage").map((row) => row.command),
    "build.accept_evidence",
    "build.fail",
  ]),
];

/**
 * Delivers a gate command to the waiting run: relaunches the project's run
 * if the executor lost it to a restart, then signals. Called before the
 * host transaction that would write host-side effects — the executor is not
 * something the database's single writer connection can be reached from
 * mid-transaction, and a refused command never reaches that write.
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
  // A fresh signal id every delivery: the gate loop may refuse and wait
  // again, and reusing the command's idempotency key would make the second
  // delivery look like a duplicate of the first.
  return deliverStageSignal(input.projectId, input.type, input.payload, crypto.randomUUID(), position?.stage).catch(
    (cause: unknown): DeliveryOutcome => {
      console.error(`[executor] ${input.projectId}: signal delivery threw:`, cause);
      return "failed";
    },
  );
}
