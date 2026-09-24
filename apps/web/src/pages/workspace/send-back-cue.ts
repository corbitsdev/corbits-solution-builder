/**
 * The resume cue a stage's specialist gets when the stage is sent back.
 *
 * A stage's opening mail goes out only onto an empty thread
 * (`use-opening-dispatch.ts`), and a send-back always lands on a thread
 * that already has history -- so without this the specialist sees nothing
 * telling it the stage came back, or why, and the person is left facing the
 * draft that was just sent back with no way forward. Stage 8 had this cue
 * first (its build worker needs a fresh attempts/ directory); every stage
 * needs the reason.
 *
 * Keyed on the workflow's own send-back decision id, embedded in the body,
 * so a reload never repeats it. Pure, so the rule is testable without the
 * hook: the hook only sends what this returns.
 */
import type { DecisionRecord } from "@solutions-builder/app/project-workflow/contracts";
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";

export type SendBackCue = { readonly marker: string; readonly body: string };

/** The most recent accepted send-back that returned the project to `stage`. */
export function latestSendBackInto(stage: number, decisions: readonly DecisionRecord[]): DecisionRecord | null {
  return (
    [...decisions].reverse().find((decision) => decision.kind === "send_back" && decision.accepted && decision.targetStage === stage) ??
    null
  );
}

export function sendBackResumeCue(input: {
  readonly stage: number;
  readonly decisions: readonly DecisionRecord[];
  /** The stage thread as loaded; a body carrying the marker means the cue went. */
  readonly messages: readonly { readonly body: string }[];
  /** The workflow-minted requirement ids. A send-back to stage 6 or earlier
   *  clears them, and the Architect may cite only these, so stage 6's cue
   *  waits until `mint_requirements` has run again and leads with the block,
   *  the same gate and prefix its opening has. */
  readonly requirements: Parameters<typeof renderRequirementsBlock>[0];
}): SendBackCue | null {
  const sendBack = latestSendBackInto(input.stage, input.decisions);
  if (!sendBack) return null;
  const marker = sendBack.decisionId;
  if (input.messages.some((message) => message.body.includes(marker))) return null;
  if (input.stage === 6 && input.requirements.length === 0) return null;
  const reason = sendBack.reason ?? "revise and resubmit.";
  const cue =
    input.stage === 8
      ? `This stage was sent back: ${reason} Continue in a new attempts/<n+1>/ directory — the next empty one — rather than reusing the last attempt. [ref:${marker}]`
      : `This stage was sent back: ${reason} Address it and send the whole document again as a new draft. [ref:${marker}]`;
  const body = input.stage === 6 ? `${renderRequirementsBlock(input.requirements)}\n\n${cue}` : cue;
  return { marker, body };
}
