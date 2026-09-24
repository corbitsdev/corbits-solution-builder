import { describe, expect, test } from "bun:test";
import type { DecisionRecord, StageNumber } from "@solutions-builder/app/project-workflow/contracts";
import { sendBackResumeCue } from "./send-back-cue.ts";

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
    expect(cue!.body).toContain("[ref:dec_6]");
    expect(cue!.body).not.toContain("attempts/");
  });

  test("stage 6 waits for the requirement ids to be minted again before cueing", () => {
    expect(sendBackResumeCue({ stage: 6, decisions: [sendBack(6)], messages: [{ body: "the old plan" }], requirements: [] })).toBeNull();
  });

  test("a cue already in the thread is never repeated, and a newer send-back gets its own", () => {
    const sent = { body: "This stage was sent back: x [ref:dec_a]" };
    expect(sendBackResumeCue({ stage: 3, decisions: [sendBack(3, "dec_a")], messages: [sent], requirements: [] })).toBeNull();
    const again = sendBackResumeCue({ stage: 3, decisions: [sendBack(3, "dec_a"), sendBack(3, "dec_b", "again")], messages: [sent], requirements: [] });
    expect(again?.marker).toBe("dec_b");
  });

  test("a refused send-back is not a send-back", () => {
    const refused = { ...sendBack(6), accepted: false };
    expect(sendBackResumeCue({ stage: 6, decisions: [refused], messages: [{ body: "x" }], requirements: REQUIREMENTS })).toBeNull();
  });

  test("stage 8 keeps its fresh-attempt instruction", () => {
    const cue = sendBackResumeCue({ stage: 8, decisions: [sendBack(8, "dec_8", "tests fail.")], messages: [{ body: "x" }], requirements: [] });
    expect(cue!.body).toContain("attempts/<n+1>/");
    expect(cue!.body).toContain("[ref:dec_8]");
  });
});
