/**
 * The nine-stage lifecycle, as a native Interchange workflow.
 *
 * One `onTrigger` section (`chat`, on mail) carries every person input for
 * every stage; a client mails the run, never signals a loop. A flat approve
 * chain of top-level gates carries approval, unchanged in signal name from
 * the loop-based design. This module is **generated** from `ledger.ts` —
 * `scripts/check-ledger.ts` asserts it and the rendered `lifecycle-source.ts`
 * agree (after `withoutStateSchemas`).
 *
 * This in-process definition is gates-only: no step here carries an agent.
 * A specialist drafting is an effect the chat body's rendered branches
 * perform once an offering exists (`lifecycle-source.ts`); here every `is-N`
 * in the chat body's router lands directly on `none`.
 */
import { defineWorkflow, onTrigger, type WorkflowDefinition } from "@intx/workflow";
import { approveChain, chatBody, CHAT_STEP_ID } from "./stage-loop.js";

export const PROJECT_LIFECYCLE_ID = "solutions-builder.project-lifecycle";

/**
 * The naming agent step's id. Rendered only once an offering exists
 * (`lifecycle-source.ts`); this in-process definition never carries it.
 */
export const NAME_STEP_ID = "name";

/**
 * Builds the definition Interchange deploys.
 *
 * Every stage waits for a human. Nothing advances on a timer, and no step
 * carries an agent: a specialist drafting is an effect the host performs
 * *inside* the chat body, never a transition. That is what keeps "models
 * draft, humans decide" true at the workflow layer and not only in the UI.
 */
export function projectLifecycleDefinition(): WorkflowDefinition {
  return defineWorkflow({
    id: PROJECT_LIFECYCLE_ID,
    // Projects are started by a person, never by a schedule or an inbound mail.
    triggers: [{ type: "manual" }],
    steps: {
      [CHAT_STEP_ID]: onTrigger({
        on: { type: "mail", to: "lifecycle@solutions-builder.local" },
        body: chatBody(),
      }),
      ...approveChain(),
    } as never,
  });
}
