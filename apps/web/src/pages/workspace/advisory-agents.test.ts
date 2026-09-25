/**
 * The advisory agents' behaviour, driven through `watchEvaluator` and
 * `askGuide` against a fake mailbox and clock: what the hooks do, without
 * React.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { askGuide, REPLY_BUDGET_MS, watchEvaluator, type AdvisoryDeps, type StageEvaluator } from "./use-advisory.ts";
import type { GuideContext } from "./product-guide.ts";

/** A mailbox of per-address threads, a hand-driven clock, and counters. */
function fakeMail() {
  const threads = new Map<string, ChatMessage[]>();
  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  let seq = 0;
  const sends: { address: string; body: string }[] = [];
  const ticks = new Set<() => void>();
  const nudges = new Set<() => void>();
  let open = 0;
  let failReads = 0;
  let holdReads: Promise<void> | null = null;
  let failSends: { count: number; leaveSentRow: boolean } = { count: 0, leaveSentRow: false };
  let onWait: (() => void) | null = null;

  const post = (address: string, author: ChatMessage["author"], body: string): ChatMessage => {
    seq += 1;
    const message = { id: `${author}:${seq}`, author, body, at: new Date(clock).toISOString() };
    threads.set(address, [...(threads.get(address) ?? []), message]);
    return message;
  };

  const deps: AdvisoryDeps = {
    ensureEvaluator: async () => ({ address: "evaluator" }),
    ensureGuide: async () => ({ address: "guide" }),
    readThread: async (_tenant, [address]) => {
      if (holdReads) await holdReads;
      if (failReads > 0) {
        failReads -= 1;
        throw new Error("offline");
      }
      return [...(threads.get(address!) ?? [])];
    },
    sendMail: async (_tenant, address, { body }) => {
      sends.push({ address, body });
      if (failSends.count > 0) {
        failSends = { ...failSends, count: failSends.count - 1 };
        // The mailbox can write the Sent copy and still fail the delivery (#61).
        if (failSends.leaveSentRow) post(address, "me", body);
        throw new Error("409 run released");
      }
      post(address, "me", body);
    },
    artifactContent: async (_tenant, id) => ({ content: contents[id] ?? "" }),
    subscribe: (_tenant, onNudge) => {
      nudges.add(onNudge);
      open += 1;
      return {
        unsubscribe: () => {
          nudges.delete(onNudge);
          open -= 1;
        },
      };
    },
    every: (_ms, fn) => {
      ticks.add(fn);
      open += 1;
      return () => {
        ticks.delete(fn);
        open -= 1;
      };
    },
    wait: async (ms) => {
      clock += ms;
      onWait?.();
    },
    now: () => clock,
  };
  const contents: Record<string, string> = {};

  return {
    deps,
    contents,
    sends,
    reply: (address: string, body: string) => post(address, "agent", body),
    /** One mailbox event, reaching every watch still subscribed, then lets
     *  the async work settle. */
    wake: async () => {
      for (const nudge of [...nudges]) nudge();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    advance: (ms: number) => void (clock += ms),
    failNextReads: (count: number) => void (failReads = count),
    failNextSends: (count: number, leaveSentRow: boolean) => void (failSends = { count, leaveSentRow }),
    /** One backstop tick, reaching every watch still ticking, then settles. */
    tick: async () => {
      for (const tick of [...ticks]) tick();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    /** Holds every read until the returned release is called. */
    holdReadsUntilReleased: () => {
      let release = () => {};
      holdReads = new Promise<void>((resolve) => (release = resolve));
      return () => {
        holdReads = null;
        release();
      };
    },
    /** One mailbox event, without settling. */
    wakeOnce: () => {
      for (const nudge of [...nudges]) nudge();
    },
    settle: async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    openSources: () => open,
    onWait: (fn: () => void) => void (onWait = fn),
  };
}

function watch(mail: ReturnType<typeof fakeMail>, body: string) {
  const states: StageEvaluator[] = [];
  const stop = watchEvaluator(mail.deps, { projectId: "p1", tenantId: "t1", body }, (state) => states.push(state));
  return { states, stop, last: () => states.at(-1) };
}

describe("watchEvaluator", () => {
  test("mails a draft once, shows its verdict, and stops listening once it is in", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    expect(run.states[0]).toEqual({ status: "checking" });
    expect(mail.sends).toEqual([{ address: "evaluator", body: "Draft A" }]);

    mail.reply("evaluator", "Verdict: ready\n- Clear success criteria");
    await mail.wake();
    expect(run.last()).toEqual({ status: "verdict", verdict: { ready: true, notes: ["Clear success criteria"] } });
    expect(mail.openSources()).toBe(0);
    expect(mail.sends).toHaveLength(1);
  });

  test("a draft already sent is read on a remount, never re-sent", async () => {
    const mail = fakeMail();
    const first = watch(mail, "Draft A");
    await mail.wake();
    first.stop();
    mail.reply("evaluator", "Verdict: not yet\n- Vague success criteria");

    const again = watch(mail, "Draft A");
    await mail.wake();
    expect(mail.sends).toHaveLength(1);
    expect(again.last()).toMatchObject({ status: "verdict", verdict: { ready: false } });
  });

  test("a late verdict on an earlier draft is never shown for the newer one", async () => {
    const mail = fakeMail();
    const a = watch(mail, "Draft A");
    await mail.wake();
    a.stop();
    const b = watch(mail, "Draft B");
    await mail.wake();

    mail.reply("evaluator", "Verdict: ready");
    await mail.wake();
    expect(b.last()).toEqual({ status: "checking" });

    mail.reply("evaluator", "Verdict: not yet\n- Missing constraints");
    await mail.wake();
    expect(b.last()).toEqual({ status: "verdict", verdict: { ready: false, notes: ["Missing constraints"] } });
  });

  test("says it cannot read only after repeated failures, and recovers when reads do", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    mail.failNextReads(3);
    await mail.wake();
    await mail.wake();
    expect(run.last()).toEqual({ status: "checking" });
    await mail.wake();
    expect(run.last()).toMatchObject({ status: "unavailable", reason: "The brief evaluator's reply could not be read: offline" });
    await mail.wake();
    expect(run.last()).toEqual({ status: "checking" });
  });

  test("a failed first read is retried rather than stalling the watch", async () => {
    const mail = fakeMail();
    mail.failNextReads(1);
    const run = watch(mail, "Draft A");
    // The watch's own first step fails; the next wake tries again.
    await mail.wake();
    expect(mail.sends).toHaveLength(1);
    expect(run.last()).toEqual({ status: "checking" });
  });

  test("says it has not answered once the budget, counted from the send, has passed", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    mail.advance(REPLY_BUDGET_MS - 1);
    await mail.wake();
    expect(run.last()).toEqual({ status: "checking" });
    mail.advance(1);
    await mail.wake();
    expect(run.last()).toEqual({ status: "unavailable", reason: "The brief evaluator has not answered yet." });
  });

  test("a remount on an old unanswered request keeps that request's deadline", async () => {
    const mail = fakeMail();
    const first = watch(mail, "Draft A");
    await mail.wake();
    first.stop();
    mail.advance(REPLY_BUDGET_MS + 1);
    const again = watch(mail, "Draft A");
    await mail.wake();
    expect(mail.sends).toHaveLength(1);
    expect(again.last()).toEqual({ status: "unavailable", reason: "The brief evaluator has not answered yet." });
  });

  test("a failed send is shown with its reason at once, and kept when its Sent copy is found", async () => {
    const mail = fakeMail();
    mail.failNextSends(1, true);
    const run = watch(mail, "Draft A");
    await mail.wake();
    expect(run.last()).toEqual({ status: "unavailable", reason: "The brief evaluator could not be reached: 409 run released" });
    await mail.wake();
    mail.advance(REPLY_BUDGET_MS);
    await mail.wake();
    expect(mail.sends).toHaveLength(1);
    expect(run.last()).toEqual({ status: "unavailable", reason: "The brief evaluator could not be reached: 409 run released" });
    // A reply that does pair still replaces it.
    mail.reply("evaluator", "Verdict: ready");
    await mail.wake();
    expect(run.last()).toMatchObject({ status: "verdict" });
  });

  test("a failed send that left no Sent copy is sent again", async () => {
    const mail = fakeMail();
    mail.failNextSends(1, false);
    const run = watch(mail, "Draft A");
    await mail.wake();
    expect(run.states).toContainEqual({ status: "unavailable", reason: "The brief evaluator could not be reached: 409 run released" });
    expect(mail.sends).toHaveLength(2);
    expect(run.last()).toEqual({ status: "checking" });
  });

  test("a wake that arrives mid-read runs again at once", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    mail.wakeOnce();
    mail.reply("evaluator", "Verdict: ready");
    mail.wakeOnce();
    await mail.settle();
    expect(run.last()).toMatchObject({ status: "verdict", verdict: { ready: true } });
  });

  test("says it has not answered once, not on every wake", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    mail.advance(REPLY_BUDGET_MS);
    await mail.wake();
    await mail.wake();
    expect(run.states.filter((state) => state.status === "unavailable")).toHaveLength(1);
  });

  test("the backstop timer alone finds the verdict when no mailbox event comes", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.tick();
    mail.reply("evaluator", "Verdict: ready");
    await mail.tick();
    expect(run.last()).toMatchObject({ status: "verdict", verdict: { ready: true } });
  });

  test("a read that completes after stop reports nothing", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    mail.reply("evaluator", "Verdict: ready");
    const release = mail.holdReadsUntilReleased();
    mail.wakeOnce();
    await mail.settle();
    run.stop();
    const seen = run.states.length;
    release();
    await mail.settle();
    expect(run.states).toHaveLength(seen);
  });

  test("reports nothing once stopped", async () => {
    const mail = fakeMail();
    const run = watch(mail, "Draft A");
    await mail.wake();
    run.stop();
    const seen = run.states.length;
    mail.reply("evaluator", "Verdict: ready");
    await mail.wake();
    expect(run.states).toHaveLength(seen);
    expect(mail.openSources()).toBe(0);
  });
});

describe("askGuide", () => {
  const node = (id: string, stage: number, kind: string): ArtifactNode =>
    ({ id, stage, kind, title: id, version: 1, supersededByNodeId: null }) as Partial<ArtifactNode> as ArtifactNode;
  const view = { done: false, openReview: null, reviews: {}, decisions: [], audiencePolicy: null, audienceDecisions: {} } as Partial<ProjectWorkflowView> as ProjectWorkflowView;
  const context: GuideContext = {
    projectTitle: "Invoice reconciliation",
    stage: 1,
    view,
    nodes: [node("brief", 1, "problem_brief"), node("upload", 1, "source_material"), node("empty", 1, "problem_brief"), node("inline", 1, "chosen_approach")],
  };

  test("hands the guide the readable versions and cites only those", async () => {
    const mail = fakeMail();
    mail.contents["brief"] = "Four hours every Friday.";
    mail.contents["upload"] = "data:application/pdf;base64,JVBERi0x";
    mail.contents["inline"] = "data:text/html;base64,PGgxPg==";
    mail.onWait(() => {
      if (mail.sends.length === 1 && !mail.sends[0]!.body.includes("upload")) mail.reply("guide", "## Where this stands\nThe brief is drafted.\n## Your options\n- Approve it");
    });
    const result = await askGuide(mail.deps, { tenantId: "t1", projectId: "p1", context }, () => true);
    expect(mail.sends[0]!.body).toContain("Four hours every Friday.");
    expect(result).toMatchObject({ note: null, guidance: { origin: "agent", sourceVersionIds: ["brief"], options: [{ label: "Approve it" }] } });
  });

  test("falls back to the checklist with why when the guide does not answer in time", async () => {
    const mail = fakeMail();
    const result = await askGuide(mail.deps, { tenantId: "t1", projectId: "p1", context }, () => true);
    expect(result).toMatchObject({ note: "The guide has not answered. Ask again in a moment.", guidance: { origin: "deterministic" } });
  });

  test("says nothing once the ask no longer matters", async () => {
    const mail = fakeMail();
    let live = true;
    mail.onWait(() => {
      live = false;
      mail.reply("guide", "## Where this stands\nToo late.");
    });
    expect(await askGuide(mail.deps, { tenantId: "t1", projectId: "p1", context }, () => live)).toBeNull();
  });
});
