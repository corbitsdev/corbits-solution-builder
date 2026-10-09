import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../../stage-mail.ts";
import { blocksToApply, loadApplied, sameRoster, saveApplied, withInterview } from "./use-stakeholders-block.ts";

const SOLO = { audiences: [{ name: "You", role: "project_owner" }], quorum: 1 };
const PAIR = { audiences: [{ name: "You", role: "project_owner" }, { name: "Brent Mattson", role: "budget_approver" }], quorum: 2 };
const INTERVIEW = { name: "Brent Mattson", interview: [{ question: "What do you most need to see to say yes?", answer: "The cost ceiling." }] };

function withBlock(id: string, roster: unknown, author: "me" | "agent" = "agent"): ChatMessage {
  return { id, author, body: ["Confirmed.", "", "```json stakeholders", JSON.stringify(roster), "```"].join("\n"), at: "2026-10-09T10:00:00Z" };
}
function withInterviewBlock(id: string, interview: unknown): ChatMessage {
  return { id, author: "agent", body: ["Noted.", "", "```json stakeholder-interview", JSON.stringify(interview), "```"].join("\n"), at: "2026-10-09T10:00:00Z" };
}
function plain(id: string, author: "me" | "agent", body: string): ChatMessage {
  return { id, author, body, at: "2026-10-09T10:00:00Z" };
}

// #722: the latest specialist reply confirming a roster is the one saved,
// once; an earlier one it supersedes is never a second save. Each
// approver's interview recorded after it is saved in order.
describe("blocksToApply", () => {
  test("is the latest specialist reply holding a valid roster, unless applied", () => {
    const messages = [plain("m1", "me", "Just me"), withBlock("a1", SOLO), plain("m2", "me", "Add Brent"), withBlock("a2", PAIR)];
    expect(blocksToApply(messages, new Set())).toEqual([{ id: "a2", kind: "roster", roster: PAIR }]);
    expect(blocksToApply(messages, new Set(["a2"]))).toEqual([]);
  });

  test("an earlier roster is superseded by the latest, not saved after it", () => {
    expect(blocksToApply([withBlock("a1", SOLO), withBlock("a2", PAIR)], new Set(["a2"]))).toEqual([]);
  });

  test("a person's message carrying a block is not a confirmation", () => {
    expect(blocksToApply([withBlock("m1", SOLO, "me")], new Set())).toEqual([]);
  });

  test("a reply whose block is invalid is passed over for the last valid one", () => {
    const messages = [withBlock("a1", SOLO), withBlock("a2", { audiences: [{ name: "Ada", role: "cfo" }], quorum: 1 })];
    expect(blocksToApply(messages, new Set())).toEqual([{ id: "a1", kind: "roster", roster: SOLO }]);
  });

  test("interviews after the roster follow it, oldest first, each once", () => {
    const you = { name: "You", interview: [{ question: "What would make you say no?", answer: "A year to build." }] };
    const messages = [withBlock("a1", PAIR), withInterviewBlock("a2", INTERVIEW), plain("m1", "me", "He wants a one-pager"), withInterviewBlock("a3", you)];
    expect(blocksToApply(messages, new Set())).toEqual([
      { id: "a1", kind: "roster", roster: PAIR },
      { id: "a2", kind: "interview", interview: INTERVIEW },
      { id: "a3", kind: "interview", interview: you },
    ]);
    expect(blocksToApply(messages, new Set(["a1", "a2"]))).toEqual([{ id: "a3", kind: "interview", interview: you }]);
  });

  test("an interview recorded before the roster was confirmed again goes with the old roster", () => {
    const messages = [withBlock("a1", SOLO), withInterviewBlock("a2", { name: "You", interview: INTERVIEW.interview }), withBlock("a3", PAIR)];
    expect(blocksToApply(messages, new Set())).toEqual([{ id: "a3", kind: "roster", roster: PAIR }]);
  });

  test("nothing to apply on a thread without one", () => {
    expect(blocksToApply([plain("a1", "agent", "Who needs to approve to move forward?\n1. Just me\n2. Others")], new Set())).toEqual([]);
  });
});

describe("sameRoster", () => {
  test("holds name for name, role for role, in order, with the quorum", () => {
    expect(sameRoster(SOLO, SOLO)).toBe(true);
    expect(sameRoster(SOLO, { ...SOLO, quorum: 0 })).toBe(false);
    expect(sameRoster(PAIR, { ...PAIR, audiences: [PAIR.audiences[1]!, PAIR.audiences[0]!] })).toBe(false);
    expect(sameRoster(SOLO, { audiences: [{ name: "You", role: "budget_approver" }], quorum: 1 })).toBe(false);
  });
});

// The interview lands on the entry it names, the others untouched.
describe("withInterview", () => {
  test("merges onto the named entry by name, case aside", () => {
    const current = { audiences: [{ name: "You", role: "project_owner", interview: [{ question: "q", answer: "a" }] }, { name: "Brent Mattson", role: "budget_approver" }], quorum: 2 };
    expect(withInterview(current, { ...INTERVIEW, name: "brent mattson" })).toEqual({
      audiences: [{ name: "You", role: "project_owner", interview: [{ question: "q", answer: "a" }] }, { name: "Brent Mattson", role: "budget_approver", interview: INTERVIEW.interview }],
      audienceQuorum: 2,
    });
  });

  test("is null when no entry has that name", () => {
    expect(withInterview(SOLO, INTERVIEW)).toBeNull();
  });
});

// Applied ids persist by project, so a reload does not save the same reply again.
describe("the applied ids", () => {
  const store = new Map<string, string>();
  const held = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = held;
  });

  test("round-trip by project", () => {
    saveApplied("p1", new Set(["a1", "a2"]));
    expect([...loadApplied("p1")]).toEqual(["a1", "a2"]);
    expect([...loadApplied("p2")]).toEqual([]);
  });

  test("storage that is unreadable or holds junk reads as none applied", () => {
    store.set("sb.stakeholders-applied.p1", "{not json");
    expect([...loadApplied("p1")]).toEqual([]);
    store.set("sb.stakeholders-applied.p1", JSON.stringify([1, "a1", null]));
    expect([...loadApplied("p1")]).toEqual(["a1"]);
  });
});

// The hook writes through the one stakeholder path, says a failed save with
// Try again (#570), and the workspace wires it for Concept approval only.
describe("the hook and its wiring", () => {
  const hook = readFileSync(join(import.meta.dir, "use-stakeholders-block.ts"), "utf8");
  const index = readFileSync(join(import.meta.dir, "index.tsx"), "utf8");

  test("saves through api.setStakeholders, each block once, in order, and only at Concept approval", () => {
    expect(hook).toContain("if (stage !== 5) return;");
    expect(hook).toContain("await api.setStakeholders(projectId, payload)");
    expect(hook).toContain("sameRoster(current, block.roster) ?");
    expect(hook).toContain("const payload = withInterview(current, block.interview);");
    expect(hook).toContain("for (const block of pending) {");
    expect(hook.indexOf("markApplied(block.id);")).toBeLessThan(hook.indexOf("onSavedRef.current(saved, block.kind);"));
  });

  test("a failed save is shown with its reason and Try again, never dropped", () => {
    expect(hook).toContain('what: "The stakeholders the Presentation creator confirmed could not be saved"');
    expect(hook).toContain("what: `${block.interview.name}'s interview could not be saved`");
    expect(hook).toContain("failedForRef.current = block.id;");
    expect(index).toContain("<FailedRead what={stakeholdersBlock.failure.what} detail={stakeholdersBlock.failure.detail} onRetry={stakeholdersBlock.retry} />");
  });

  test("a save refreshes the panel and recaptures the review; the interview arms the sole approver's write", () => {
    const onSaved = index.slice(index.indexOf("const stakeholdersBlock = useStakeholdersBlock({"), index.indexOf("// Holding send raises"));
    expect(onSaved).toContain('if (kind === "interview") setRosterFromChat({ saved, at: Date.now() });');
    expect(onSaved).toContain("void refreshWorkflow();");
    expect(onSaved).toContain("void loadThread();");
    expect(onSaved).toContain("void openReviewNow();");
    expect(index).toContain("rosterSavedInChat={rosterFromChat}");
  });
});
