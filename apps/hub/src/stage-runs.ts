/**
 * Waiting for a stage's agent steps to answer.
 *
 * A drafting round is fired by delivering a signal (`hub-executor.ts`'s
 * `deliverStageSignal`); nothing about the reply is synchronous. This is the
 * other half: poll the deployment's own run log until the iteration that
 * signal opened has completed every agent step a caller names, or failed
 * one, or run out the clock. The request that fires the round is not this
 * file's job — see the module header on `stage-thread.ts` for why the two
 * stay separate.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import type { HubRunEvent } from "./hub-client.js";
import { readOutputRef, stageIterations } from "./hub-executor.js";
import { HostError } from "./errors.js";

const POLL_INTERVAL_MS = 500;

function eventBody(event: HubRunEvent): Record<string, unknown> {
  return event.body;
}

function findEvent(events: HubRunEvent[], kind: string, stepId: string): HubRunEvent | undefined {
  return events.find((event) => event.type === kind && eventBody(event).stepId === stepId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for the newest iteration beyond `afterIteration` to complete every
 * step in `stepIds`, and returns each one's resolved `{reply}` output.
 * Throws `HostError("provider_unavailable", …)` the moment any of them fails,
 * quoting the run's own error message, and again if nothing has answered by
 * `timeoutMs`.
 */
export async function awaitIterationOutputs(args: {
  readonly projectId: string;
  readonly stage: Stage;
  readonly afterIteration: number;
  readonly stepIds: readonly string[];
  readonly timeoutMs: number;
}): Promise<{ runId: string; outputs: Map<string, { reply: string }> }> {
  const deadline = Date.now() + args.timeoutMs;

  for (;;) {
    const iterations = await stageIterations(args.projectId, args.stage);
    const newestIndex = iterations.length - 1;

    if (newestIndex > args.afterIteration) {
      const iteration = iterations[newestIndex]!;
      const anchor = iteration.runId.split("__", 1)[0]!;

      for (const stepId of args.stepIds) {
        const failed = findEvent(iteration.events, "StepFailed", stepId);
        if (failed) {
          const error = eventBody(failed).error as { message?: string } | undefined;
          throw new HostError(
            "provider_unavailable",
            `The ${stepId} step failed: ${error?.message ?? "no error message was recorded"}.`,
            {},
            true,
          );
        }
      }

      const completed = args.stepIds.map((stepId) => findEvent(iteration.events, "StepCompleted", stepId));
      if (completed.every((event) => event !== undefined)) {
        const outputs = new Map<string, { reply: string }>();
        for (const [index, stepId] of args.stepIds.entries()) {
          const output = eventBody(completed[index]!).output as { ref?: unknown } | undefined;
          if (typeof output?.ref !== "string") {
            throw new HostError("internal_error", `The ${stepId} step completed with no output ref.`);
          }
          outputs.set(stepId, (await readOutputRef(anchor, iteration.runId, output.ref)) as { reply: string });
        }
        return { runId: iteration.runId, outputs };
      }
    }

    if (Date.now() >= deadline) {
      throw new HostError(
        "provider_unavailable",
        `No reply arrived for stage ${args.stage} within ${Math.round(args.timeoutMs / 1000)}s.`,
        {},
        true,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
