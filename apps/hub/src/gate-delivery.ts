/**
 * The host's one signal to a run: the `stage.draft` round.
 *
 * A gate is the platform's: a person's decision is a named signal the client
 * delivers over `/hub`, authorized by the `signal:<name>` grant, deduplicated
 * by its `signalId`, admitted by `admitGate` inside the run. Nothing here
 * evaluates or delivers a gate.
 *
 * A draft is different: the host assembles the round (the prompt, the quotes,
 * the inference the specialist will draft with) and relays it to the stage's
 * round awaiter. The executor's run map is in memory, so a restart loses it;
 * relaunching is idempotent, and doing it right before a round is what keeps
 * the runtime alive across a closed window.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import { deliverStageSignal, hasExecution, launchProjectLifecycle, type DeliveryOutcome } from "./lifecycle-run.js";
import type { CommandInput } from "./command-dispatch.js";

/** The one command the host signals on a person's behalf. */
export const ROUND_COMMAND = "stage.draft";

/**
 * Relays a draft round to the stage the ledger says is open. The signal id is
 * the command's idempotency key: a retried draft is one round, not two, on
 * the runtime and on the ledger alike.
 */
export async function deliverRound(input: CommandInput, stage: Stage): Promise<DeliveryOutcome> {
  if (input.type !== ROUND_COMMAND) throw new Error(`${input.type} is decided on the run, not relayed by the host.`);
  if (!hasExecution(input.projectId)) {
    await launchProjectLifecycle({ projectId: input.projectId }).catch((cause: unknown) => {
      console.error(`[executor] ${input.projectId}: could not relaunch after restart:`, cause);
    });
  }
  return deliverStageSignal(
    input.projectId,
    ROUND_COMMAND,
    { ...input.payload, command: ROUND_COMMAND },
    input.idempotencyKey,
    stage,
  ).catch((cause: unknown): DeliveryOutcome => {
    console.error(`[executor] ${input.projectId}: round delivery threw:`, cause);
    return "failed";
  });
}
