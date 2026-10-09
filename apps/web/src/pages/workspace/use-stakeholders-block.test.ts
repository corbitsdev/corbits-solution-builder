import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../../stage-mail.ts";
import { loadApplied, rosterToApply, sameRoster, saveApplied } from "./use-stakeholders-block.ts";

const SOLO = { audiences: [{ name: "You", role: "project_owner" }], quorum: 1 };
const PAIR = { audiences: [{ name: "You", role: "project_owner" }, { name: "Brent Mattson", role: "budget_approver" }], quorum: 2 };

function withBlock(id: string, roster: unknown, author: "me" | "agent" = "agent"): ChatMessage {
  return { id, author, body: ["Confirmed.", "", "```json stakeholders", JSON.stringify(roster), "```"].join("\n"), at: "2026-10-09T10:00:00Z" };
}
function plain(id: string, author: "me" | "agent", body: string): ChatMessage {
  return { id, author, body, at: "2026-10-09T10:00:00Z" };
}

// #722: the latest specialist reply confirming a roster is the one saved,
// once; an earlier one it supersedes is never a second save.
describe("rosterToApply", () => {
  test("is the latest specialist reply holding a valid block, unless applied", () => {
    const messages = [plain("m1", "me", "Just me"), withBlock("a1", SOLO), plain("m2", "me", "Add Brent"), withBlock("a2", PAIR)];
    expect(rosterToApply(messages, new Set())).toEqual({ id: "a2", roster: PAIR });
    expect(rosterToApply(messages, new Set(["a2"]))).toBeNull();
  });

  test("an earlier reply is superseded by the latest, not saved after it", () => {
    const messages = [withBlock("a1", SOLO), withBlock("a2", PAIR)];
    expect(rosterToApply(messages, new Set(["a2"]))).toBeNull();
  });

  test("a person's message carrying a block is not a confirmation", () => {
    expect(rosterToApply([withBlock("m1", SOLO, "me")], new Set())).toBeNull();
  });

  test("a reply whose block is invalid is passed over for the last valid one", () => {
    const messages = [withBlock("a1", SOLO), withBlock("a2", { audiences: [{ name: "Ada", role: "cfo" }], quorum: 1 })];
    expect(rosterToApply(messages, new Set())).toEqual({ id: "a1", roster: SOLO });
  });

  test("nothing to apply on a thread without one", () => {
    expect(rosterToApply([plain("a1", "agent", "Who needs to approve to move forward?\n1. Just me\n2. Others")], new Set())).toBeNull();
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

  test("saves through api.setStakeholders, once per reply, and only at Concept approval", () => {
    expect(hook).toContain("if (stage !== 5) return;");
    expect(hook).toContain("await api.setStakeholders(projectId, payload)");
    expect(hook).toContain("sameRoster(current, pending.roster) ? payload :");
    expect(hook).toContain("if (!pending || inFlightRef.current === pending.id || failedForRef.current === pending.id) return;");
    expect(hook.indexOf("markApplied();")).toBeLessThan(hook.indexOf("onSavedRef.current(saved);"));
  });

  test("a failed save is shown with its reason and Try again, never dropped", () => {
    expect(hook).toContain('what: "The stakeholders the Presentation creator confirmed could not be saved"');
    expect(hook).toContain("failedForRef.current = pending.id;");
    expect(index).toContain("<FailedRead what={stakeholdersBlock.failure.what} detail={stakeholdersBlock.failure.detail} onRetry={stakeholdersBlock.retry} />");
  });

  test("a saved roster refreshes the panel, recaptures the review and arms the sole approver's write", () => {
    const onSaved = index.slice(index.indexOf("const stakeholdersBlock = useStakeholdersBlock({"), index.indexOf("// Holding send raises"));
    expect(onSaved).toContain("setRosterFromChat({ saved, at: Date.now() });");
    expect(onSaved).toContain("void refreshWorkflow();");
    expect(onSaved).toContain("void loadThread();");
    expect(onSaved).toContain("void openReviewNow();");
    expect(index).toContain("rosterSavedInChat={rosterFromChat}");
  });
});
