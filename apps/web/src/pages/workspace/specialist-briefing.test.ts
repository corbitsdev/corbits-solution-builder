import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import { BRIEFING_LEAD, briefingState, briefingSubject, composeBriefing } from "./use-specialist-briefing.ts";
import { HANDOFF_CLOSE, specialistBriefed } from "./use-model-handoff.ts";

const at = "2026-09-26T15:08:00.000Z";
const me = (body: string, subject?: string): ChatMessage => ({ id: body.slice(0, 10), author: "me", body, at, ...(subject ? { subject } : {}) });
const agent = (body: string): ChatMessage => ({ id: body.slice(0, 10), author: "agent", body, at });

describe("briefingState", () => {
  test("unknown with nothing to judge, or while a hand-off is still due", () => {
    expect(briefingState([], false)).toBe("unknown");
    expect(briefingState([me("Stage 4 is waiting on a decision", "[decision:p:4:stage-approval] x")], true)).toBe("unknown");
  });

  test("unbriefed when the thread holds mail and no briefing; briefed once one is there", () => {
    const bare = [me("This stage was sent back: Sent back from stage 5 to stage 4."), agent("The decision came through without its reason, and neither the brief nor the previous mockup came with it.")];
    expect(briefingState(bare, false)).toBe("unbriefed");
    expect(briefingState([...bare, me(composeBriefing({ record: "What was approved…", draft: null }), briefingSubject("tnt_1", 4))], false)).toBe("briefed");
    expect(briefingState([me("Record…", "[opening:tnt_1:4] GUI design"), agent("Mockup")], false)).toBe("briefed");
  });
});

describe("composeBriefing", () => {
  test("leads with why, carries the record and the draft, and closes the way a hand-off does", () => {
    const body = composeBriefing({ record: "What was approved before this stage, and what the person provided:\n\n## Problem brief\n…", draft: "<!doctype html><html>mockup</html>" });
    expect(body.startsWith(BRIEFING_LEAD)).toBe(true);
    expect(body.indexOf("What was approved before this stage")).toBeLessThan(body.indexOf("The current draft:"));
    expect(body.endsWith(HANDOFF_CLOSE)).toBe(true);
    // The briefing counts as one, by its subject and by the record it carries.
    expect(specialistBriefed([me(body, briefingSubject("tnt_1", 4))])).toBe(true);
    expect(specialistBriefed([me(body)])).toBe(true);
    // Without a record or a draft it is the lead and the close alone.
    expect(composeBriefing({ record: "", draft: null })).toBe(`${BRIEFING_LEAD}\n\n---\n\n${HANDOFF_CLOSE}`);
  });

  test("the subject names the project and the stage", () => {
    expect(briefingSubject("tnt_1", 4)).toBe("[briefing:tnt_1:4] GUI design");
  });
});
