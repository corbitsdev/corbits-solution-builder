import { describe, expect, test } from "bun:test";
import { nextOpenQuestion, type StageTurn } from "./stage-thread.js";

/**
 * CL-8062: the stage-3 interview looped forever. The model absorbed every
 * answer into the next draft and re-emitted the answered questions, and the
 * open-question count restarted from the repeat every round — so the thread
 * never ran dry and the approval control never rendered. A repeat of an
 * earlier round's question was answered there, so it must not reopen.
 *
 * Ported from `apps/hub/src/stage-interview-repeats.test.ts` (CL-8379):
 * `nextOpenQuestion` is now the pure fold both the hub and the web client
 * import, so its tests live beside it.
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
