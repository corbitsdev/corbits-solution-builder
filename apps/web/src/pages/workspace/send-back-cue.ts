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
 * Keyed on the workflow's own send-back decision id, carried in the subject
 * (#708) the way an opening carries `[opening:…]`, so a reload never repeats
 * it. The body carries the reason, then the record (#799): everything
 * approved before this stage, and the draft that was sent back. A send-back
 * often lands on a specialist that was just deployed and has nothing else
 * to read; one that got only "this was sent back" once redrew a different
 * product. Pure, so the rule is testable without the hook: the hook only
 * sends what this returns.
 */
import type { DecisionRecord } from "@solutions-builder/app/project-workflow/contracts";
import { renderRequirementsBlock } from "@solutions-builder/app/requirements";
import { stageName } from "../../components.jsx";

export type SendBackCue = { readonly marker: string; readonly subject: string; readonly body: string };

/** Leads the sent-back draft in the cue; a specialist's own reply never starts with it. */
export const SENT_BACK_DRAFT_LEAD = "--- THE DRAFT THAT WAS SENT BACK; THE REVISION STARTS FROM IT ---";

const SENT_BACK_SUBJECT = /^\[sent-back:([^\]]+)\]/;

/** The decision id a send-back cue's subject carries, or null for any other mail. */
export function sendBackCueIdOf(subject: string | undefined): string | null {
  return subject ? (SENT_BACK_SUBJECT.exec(subject)?.[1] ?? null) : null;
}

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
  /** The stage thread as loaded; a subject carrying the marker means the cue
   *  went. A body carrying it is a cue sent before the marker moved (#708). */
  readonly messages: readonly { readonly body: string; readonly subject?: string }[];
  /** The workflow-minted requirement ids. A send-back to stage 6 or earlier
   *  clears them, and the Architect may cite only these, so stage 6's cue
   *  waits until `mint_requirements` has run again and leads with the block,
   *  the same gate and prefix its opening has. */
  readonly requirements: Parameters<typeof renderRequirementsBlock>[0];
  /** The approved record before this stage, as `renderApprovedChain` renders it; "" or absent when there is none. */
  readonly record?: string | null;
  /** The draft that was sent back, whole, so the revision starts from it rather than from memory. */
  readonly draft?: string | null;
}): SendBackCue | null {
  const sendBack = latestSendBackInto(input.stage, input.decisions);
  if (!sendBack) return null;
  const marker = sendBack.decisionId;
  if (input.messages.some((message) => sendBackCueIdOf(message.subject) === marker || message.body.includes(`[ref:${marker}]`))) return null;
  if (input.stage === 6 && input.requirements.length === 0) return null;
  const reason = sendBack.reason ?? "revise and resubmit.";
  const cue =
    input.stage === 8
      ? `This stage was sent back: ${reason} Continue in a new attempts/<n+1>/ directory — the next empty one — rather than reusing the last attempt.`
      : `This stage was sent back: ${reason} Address it and send the whole document again as a new draft.`;
  const led = input.stage === 6 ? `${renderRequirementsBlock(input.requirements)}\n\n${cue}` : cue;
  const record = input.record?.trim() ? input.record.trim() : null;
  const draft = input.draft?.trim() ? `${SENT_BACK_DRAFT_LEAD}\n\n${input.draft.trim()}` : null;
  const body = [led, record, draft].filter((part): part is string => part !== null).join("\n\n");
  return { marker, subject: `[sent-back:${marker}] ${stageName(input.stage)}`, body };
}
