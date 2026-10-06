import { describe, expect, test } from "bun:test";
import type { DecisionRecord, StageNumber } from "@solutions-builder/app/project-workflow/contracts";
import { SENT_BACK_DRAFT_LEAD, sendBackCueIdOf, sendBackResumeCue } from "./send-back-cue.ts";

function sendBack(target: number, id = "dec_1", reason?: string): DecisionRecord {
  return {
    decisionId: id,
    kind: "send_back",
    stage: 7,
    accepted: true,
    principalId: "prn_1",
    targetStage: target as StageNumber,
    ...(reason !== undefined ? { reason } : {}),
  };
}

const REQUIREMENTS = [{ id: "FR-1", kind: "FR" as const, text: "It works." }];

describe("sendBackResumeCue", () => {
  test("no send-back into this stage: nothing to say", () => {
    expect(sendBackResumeCue({ stage: 6, decisions: [sendBack(8)], messages: [{ body: "hi" }], requirements: REQUIREMENTS })).toBeNull();
  });

  test("a send-back into stage 6 cues the architect with the reason, led by the re-minted requirement ids", () => {
    const cue = sendBackResumeCue({
      stage: 6,
      decisions: [sendBack(6, "dec_6", "The approved build plan has no Stack section. Please re-issue it with one.")],
      messages: [{ body: "the old plan" }],
      requirements: REQUIREMENTS,
    });
    expect(cue).not.toBeNull();
    expect(cue!.marker).toBe("dec_6");
    expect(cue!.body).toContain("This stage was sent back: The approved build plan has no Stack section.");
    expect(cue!.body).toContain("FR-1");
    expect(cue!.body.indexOf("FR-1")).toBeLessThan(cue!.body.indexOf("This stage was sent back"));
    expect(cue!.subject).toBe("[sent-back:dec_6] Build plan");
    expect(cue!.body).not.toContain("[ref:");
    expect(cue!.body).not.toContain("attempts/");
  });

  test("stage 6 waits for the requirement ids to be minted again before cueing", () => {
    expect(sendBackResumeCue({ stage: 6, decisions: [sendBack(6)], messages: [{ body: "the old plan" }], requirements: [] })).toBeNull();
  });

  test("a cue already in the thread is never repeated, and a newer send-back gets its own", () => {
    const sent = { body: "This stage was sent back: x", subject: "[sent-back:dec_a] Solution proposal" };
    expect(sendBackResumeCue({ stage: 3, decisions: [sendBack(3, "dec_a")], messages: [sent], requirements: [] })).toBeNull();
    const again = sendBackResumeCue({ stage: 3, decisions: [sendBack(3, "dec_a"), sendBack(3, "dec_b", "again")], messages: [sent], requirements: [] });
    expect(again?.marker).toBe("dec_b");
  });

  test("a cue sent before the marker moved to the subject still counts as sent", () => {
    const legacy = { body: "This stage was sent back: x [ref:dec_a]" };
    expect(sendBackResumeCue({ stage: 3, decisions: [sendBack(3, "dec_a")], messages: [legacy], requirements: [] })).toBeNull();
  });

  test("the subject's id is read back, and only from a subject", () => {
    expect(sendBackCueIdOf("[sent-back:dec_9] Build and test")).toBe("dec_9");
    expect(sendBackCueIdOf("[opening:p:3] Solution proposal")).toBeNull();
    expect(sendBackCueIdOf(undefined)).toBeNull();
  });

  test("a refused send-back is not a send-back", () => {
    const refused = { ...sendBack(6), accepted: false };
    expect(sendBackResumeCue({ stage: 6, decisions: [refused], messages: [{ body: "x" }], requirements: REQUIREMENTS })).toBeNull();
  });

  // #799: the cue carries the record and the sent-back draft, in that order, after the reason.
  test("carries the approved record and the sent-back draft after the reason", () => {
    const cue = sendBackResumeCue({
      stage: 4,
      decisions: [sendBack(4, "dec_9", "The colours should be more muted; keep every screen as it is otherwise.")],
      messages: [],
      requirements: [],
      record: "What was approved before this stage, and what the person provided:\n\n## Problem brief\nAn iPhone app called workout log.\n\n--- END OF THE RECORD; THIS STAGE'S OPENING FOLLOWS ---",
      draft: "<!doctype html><html><body>Mockup — workout log iPhone app</body></html>",
    });
    expect(cue?.body.startsWith("This stage was sent back: The colours should be more muted; keep every screen as it is otherwise. Address it and send the whole document again as a new draft.")).toBe(true);
    const reason = cue!.body.indexOf("This stage was sent back");
    const record = cue!.body.indexOf("What was approved before this stage");
    const draft = cue!.body.indexOf(SENT_BACK_DRAFT_LEAD);
    expect(reason).toBeLessThan(record);
    expect(record).toBeLessThan(draft);
    expect(cue!.body.endsWith("Mockup — workout log iPhone app</body></html>")).toBe(true);
    // Without a record or a draft the body is the instruction alone, as before.
    expect(sendBackResumeCue({ stage: 4, decisions: [sendBack(4, "dec_9", "Muted colours.")], messages: [], requirements: [], record: "", draft: null })!.body).toBe(
      "This stage was sent back: Muted colours. Address it and send the whole document again as a new draft.",
    );
  });

  test("stage 8 keeps its fresh-attempt instruction", () => {
    const cue = sendBackResumeCue({ stage: 8, decisions: [sendBack(8, "dec_8", "tests fail.")], messages: [{ body: "x" }], requirements: [] });
    expect(cue!.body).toContain("attempts/<n+1>/");
    expect(cue!.subject).toBe("[sent-back:dec_8] Build and test");
  });
});
