/**
 * The remaining workflows §9 names: approval, design-feedback, provider-switch,
 * build-supervision and delivery.
 *
 * Each is generated from the ledger rather than modelled beside it, on the same
 * rule as the lifecycle: the commands that can leave a state *are* the signals
 * a step accepts. So none of these can offer a transition the guard would
 * refuse, and adding a row to the ledger adds it here.
 *
 * They are separate definitions rather than branches of one workflow because
 * they have different lifetimes. An approval is over in one decision. A build
 * outlives the window being closed. Provider switching happens between other
 * things and must not carry their state. §9's own list is drawn along those
 * lines, and one giant workflow would erase them.
 */
import { awaitSignal, defineWorkflow, type WorkflowDefinition } from "@intx/workflow";
import { LEDGER, type Command, type RunKind, type RunState } from "../ledger.js";

export const APPROVAL_WORKFLOW_ID = "solutions-builder.approval";
export const DESIGN_FEEDBACK_WORKFLOW_ID = "solutions-builder.design-feedback";
export const PROVIDER_SWITCH_WORKFLOW_ID = "solutions-builder.provider-switch";
export const BUILD_SUPERVISION_WORKFLOW_ID = "solutions-builder.build-supervision";
export const DELIVERY_WORKFLOW_ID = "solutions-builder.delivery";

/** Every command the ledger allows out of one state. */
export function commandsLeaving(kind: RunKind, state: RunState): Command[] {
  const commands = LEDGER.filter(
    (row) => row.from?.kind === kind && row.from.state === state,
  ).map((row) => row.command);
  return [...new Set(commands)];
}

function signalsFor(workflowId: string, commands: readonly Command[]): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const command of commands) {
    steps[command.replace(/\./g, "-")] = awaitSignal({
      name: `${workflowId}.${command}`,
      // Every one of these waits on a person or on a worker that reports to
      // one. None of them may expire into a decision nobody took.
      drainBehavior: "wait",
    });
  }
  return steps;
}

function definition(
  id: string,
  commands: readonly Command[],
  schema: Record<string, string>,
): WorkflowDefinition {
  return defineWorkflow({
    id,
    triggers: [{ type: "manual" }],
    steps: signalsFor(id, commands) as never,
    state: { schema: schema as never },
  });
}

/** The gate itself: what a reviewer may do with a submitted stage. */
export function approvalDefinition(): WorkflowDefinition {
  return definition(APPROVAL_WORKFLOW_ID, commandsLeaving("stage", "waiting_approval"), {
    projectId: "string",
    runId: "string",
    stage: "number",
  });
}

/**
 * Stage 4's loop. Feedback is submitted once and immutably, then a new design
 * version is drafted from it, so this waits on the same stage commands — the
 * revision is an effect the host performs, not a transition of its own.
 */
export function designFeedbackDefinition(): WorkflowDefinition {
  return definition(DESIGN_FEEDBACK_WORKFLOW_ID, commandsLeaving("stage", "in_progress"), {
    projectId: "string",
    runId: "string",
    designNodeId: "string",
  });
}

/**
 * Switching providers regenerates from approved input without rewriting
 * history, so it holds no run state of its own — only which binding is being
 * changed and which artifact is being regenerated.
 */
export function providerSwitchDefinition(): WorkflowDefinition {
  return defineWorkflow({
    id: PROVIDER_SWITCH_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    // The only definition here whose signal is not a ledger command, because
    // switching a provider is not a transition: it changes a binding and
    // regenerates from approved input. It still waits on a person — §9 is
    // explicit that there is "no silent change after review starts" — so the
    // wait is modelled rather than assumed.
    steps: {
      "choose-binding": awaitSignal({
        name: `${PROVIDER_SWITCH_WORKFLOW_ID}.binding.chosen`,
        drainBehavior: "wait",
      }),
    } as never,
    state: {
      schema: {
        projectId: "string",
        bindingId: "string",
        artifactId: "string",
      } as never,
    },
  });
}

/** Stage 8, which outlives the window: every build state the ledger names. */
export function buildSupervisionDefinition(): WorkflowDefinition {
  const commands = [
    ...commandsLeaving("build", "queued"),
    ...commandsLeaving("build", "running"),
    ...commandsLeaving("build", "waiting_human"),
    ...commandsLeaving("build", "interrupted"),
  ];
  return definition(BUILD_SUPERVISION_WORKFLOW_ID, [...new Set(commands)], {
    projectId: "string",
    runId: "string",
    packetId: "string",
  });
}

/** Stage 9: accept the manifest, or send it back with a route. */
export function deliveryDefinition(): WorkflowDefinition {
  return definition(DELIVERY_WORKFLOW_ID, commandsLeaving("stage", "delivery_review"), {
    projectId: "string",
    runId: "string",
    manifestId: "string",
  });
}
