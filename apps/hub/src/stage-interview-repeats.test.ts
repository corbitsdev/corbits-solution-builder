import { describe, expect, test } from "bun:test";
import { ensureChoiceSection, withChoiceReminder } from "@solutions-builder/app/stage-prompt";
import { nextOpenQuestion } from "./stage-thread.js";
import type { StageTurn } from "./stage-thread.js";

/**
 * CL-8062: the stage-3 interview looped forever. The model absorbed every
 * answer into the next draft and re-emitted the answered questions, and the
 * open-question count restarted from the repeat every round — so the thread
 * never ran dry and the approval control never rendered. A repeat of an
 * earlier round's question was answered there, so it must not reopen.
 */
function turn(id: string, role: "human" | "specialist", questions: string[] | null): StageTurn {
  return { id, role, body: `${role} ${id}`, quotes: [], resultNodeId: null, questions, createdAt: "2026-09-16T00:00:00Z" };
}

const Q1 = "What should the endpoint return when nothing is queued?";
const Q2 = "Should the worker retry a failed delivery?";
const Q3 = "What happens if the endpoint is unreachable during boot?";

describe("nextOpenQuestion skips questions answered in an earlier round", () => {
  test("a fresh round re-emitting only answered questions leaves nothing open", () => {
    const turns = [
      turn("s0", "specialist", [Q1, Q2, Q3]),
      turn("h0", "human", null),
      turn("h1", "human", null),
      turn("h2", "human", null),
      turn("s1", "specialist", [Q1, Q2, Q3]),
    ];
    expect(nextOpenQuestion(turns)).toBeNull();
  });

  test("a fresh question beside repeats is the one asked", () => {
    const Q4 = "How long should the boot retry window last?";
    const turns = [
      turn("s0", "specialist", [Q1, Q2, Q3]),
      turn("h0", "human", null),
      turn("h1", "human", null),
      turn("h2", "human", null),
      turn("s1", "specialist", [Q1, Q2, Q3, Q4]),
    ];
    const open = nextOpenQuestion(turns);
    expect(open?.body).toBe(Q4);
    expect(open?.remaining).toBe(0);
  });

  test("repeats in other casing or spacing still count as answered", () => {
    const turns = [
      turn("s0", "specialist", [Q1]),
      turn("h0", "human", null),
      turn("s1", "specialist", [`  ${Q1.toUpperCase()}  `]),
    ];
    expect(nextOpenQuestion(turns)).toBeNull();
  });

  test("an unanswered round still asks in order", () => {
    const turns = [turn("s0", "specialist", [Q1, Q2]), turn("h0", "human", null)];
    const open = nextOpenQuestion(turns);
    expect(open?.body).toBe(Q2);
    expect(open?.ordinal).toBe(1);
    expect(open?.remaining).toBe(0);
  });

  test("a question abandoned by revise and re-asked next round is asked", () => {
    const turns = [
      turn("s0", "specialist", [Q1, Q2]),
      turn("h0", "human", null),
      turn("s1", "specialist", [Q2, Q3]),
    ];
    const open = nextOpenQuestion(turns);
    expect(open?.body).toBe(Q2);
    expect(open?.ordinal).toBe(0);
  });
});

describe("withChoiceReminder records a stage-3 choice in the document", () => {
  test("a stage-3 choice names the Chosen approach section the approval gate reads", () => {
    const out = withChoiceReminder(3, "Chosen: Approach A (Extend the worker)");
    expect(out).toContain("Chosen: Approach A (Extend the worker)");
    expect(out).toContain("## Chosen approach: Extend the worker");
  });

  test("ordinary stage-3 replies and other stages pass through untouched", () => {
    expect(withChoiceReminder(3, "Use Postgres.")).toBe("Use Postgres.");
    expect(withChoiceReminder(2, "Chosen: Approach A (Extend the worker)")).toBe("Chosen: Approach A (Extend the worker)");
  });
});

describe("ensureChoiceSection repairs a draft that ignored the reminder", () => {
  const draft = [
    "## In short",
    "",
    "Two viable approaches.",
    "",
    "## Approach A: Extend the worker",
    "",
    "How it works.",
    "",
    "## Side by side",
    "",
    "The table.",
    "",
  ].join("\n");

  test("a non-compliant draft gains the Chosen approach section after In short", () => {
    const out = ensureChoiceSection(3, "Chosen: Approach A (Extend the worker)", draft);
    expect(out).toContain("## Chosen approach: Extend the worker");
    expect(out).toContain("The person chose Approach A (Extend the worker).");
    expect(out.indexOf("## Chosen approach")).toBeGreaterThan(out.indexOf("## In short"));
    expect(out.indexOf("## Chosen approach")).toBeLessThan(out.indexOf("## Approach A"));
  });

  test("a draft that already records the choice passes through untouched", () => {
    const compliant = draft.replace("## Side by side", "## Chosen approach: Extend the worker\n\nIt won.\n\n## Side by side");
    expect(ensureChoiceSection(3, "Chosen: Approach A (Extend the worker)", compliant)).toBe(compliant);
  });

  test("ordinary replies and other stages pass through untouched", () => {
    expect(ensureChoiceSection(3, "Use Postgres.", draft)).toBe(draft);
    expect(ensureChoiceSection(2, "Chosen: Approach A (Extend the worker)", draft)).toBe(draft);
  });
});
