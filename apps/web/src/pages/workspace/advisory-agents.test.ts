/**
 * The advisory agents' behaviour, driven through `judgeDraft` and
 * `askGuide` against a fake mailbox and clock: what the hooks do, without
 * React.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";
import { askGuide, judgeDraft, REPLY_BUDGET_MS, type AdvisoryDeps } from "./use-advisory.ts";
import type { GuideContext } from "./product-guide.ts";

/** A mailbox of per-address threads, a hand-driven clock, and counters. */
function fakeMail() {
  const threads = new Map<string, ChatMessage[]>();
  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  let seq = 0;
  const sends: { address: string; body: string; subject: string }[] = [];
  let failSends = 0;
  let onWait: (() => void) | null = null;

  // Each address is a run answering its accepted triggers in arrival order,
  // its reply naming the trigger it answers (#62).
  const unanswered = new Map<string, string[]>();
  const post = (address: string, message: Omit<ChatMessage, "id" | "at">): ChatMessage => {
    seq += 1;
    const posted = { ...message, id: `${message.author}:${seq}`, at: new Date(clock).toISOString() };
    threads.set(address, [...(threads.get(address) ?? []), posted]);
    return posted;
  };
  const trigger = (address: string, body: string, subject?: string) => {
    const triggerMessageId = `<t${seq + 1}@hub>`;
    unanswered.set(address, [...(unanswered.get(address) ?? []), triggerMessageId]);
    post(address, { author: "me", body, triggerMessageId, ...(subject ? { subject } : {}) });
  };

  const deps: AdvisoryDeps = {
    ensureEvaluator: async () => ({ address: "evaluator" }),
    ensureGuide: async () => ({ address: "guide" }),
    readThread: async (_tenant, [address]) => [...(threads.get(address!) ?? [])],
    sendMail: async (_tenant, address, { body, subject }) => {
      sends.push({ address, body, subject });
      if (failSends > 0) {
        failSends -= 1;
        throw new Error("409 run released");
      }
      trigger(address, body, subject);
    },
    artifactContent: async (_tenant, id) => ({ content: contents[id] ?? "" }),
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
    reply: (address: string, body: string) => {
      const [inReplyTo, ...rest] = unanswered.get(address) ?? [];
      unanswered.set(address, rest);
      return post(address, { author: "agent", body, ...(inReplyTo !== undefined ? { inReplyTo } : {}) });
    },
    advance: (ms: number) => void (clock += ms),
    failNextSend: () => void (failSends = 1),
    onWait: (fn: () => void) => void (onWait = fn),
  };
}

const judge = (mail: ReturnType<typeof fakeMail>, tag: string, body = `${tag} body`) =>
  judgeDraft(mail.deps, { projectId: "p1", tenantId: "t1", stage: 2, tag, body, signal: new AbortController().signal });

describe("judgeDraft", () => {
  test("mails a draft once under its tag and reads the verdict paired with it", async () => {
    const mail = fakeMail();
    mail.onWait(() => {
      if (mail.sends.length === 1) mail.reply("evaluator", "Verdict: not yet\n- Vague success criteria");
    });
    expect(await judge(mail, "[evaluation:2:a]", "Draft A")).toEqual({ status: "verdict", verdict: { ready: false, notes: ["Vague success criteria"] } });
    expect(mail.sends).toEqual([{ address: "evaluator", body: "Draft A", subject: "[evaluation:2:a] Stage 2 draft for review" }]);
  });

  test("a draft already sent is read again, never re-sent", async () => {
    const mail = fakeMail();
    mail.onWait(() => mail.reply("evaluator", "Verdict: ready"));
    await judge(mail, "[evaluation:2:a]");
    expect(await judge(mail, "[evaluation:2:a]")).toMatchObject({ status: "verdict", verdict: { ready: true } });
    expect(mail.sends).toHaveLength(1);
  });

  test("a verdict on an earlier draft is never taken as the newer one's", async () => {
    const mail = fakeMail();
    mail.onWait(() => {
      if (mail.sends.length === 1) mail.reply("evaluator", "Verdict: ready");
      if (mail.sends.length === 2) mail.reply("evaluator", "Verdict: not yet\n- Missing constraints");
    });
    await judge(mail, "[evaluation:2:a]");
    expect(await judge(mail, "[evaluation:2:b]")).toEqual({ status: "verdict", verdict: { ready: false, notes: ["Missing constraints"] } });
  });

  test("says it has not answered once the budget, counted from the send, has passed", async () => {
    const mail = fakeMail();
    expect(await judge(mail, "[evaluation:2:a]")).toEqual({ status: "unavailable", reason: "The evaluator has not answered yet." });
  });

  test("an old unanswered request keeps its own deadline", async () => {
    const mail = fakeMail();
    await judge(mail, "[evaluation:2:a]");
    mail.advance(1);
    mail.onWait(() => {
      throw new Error("waited past the old deadline");
    });
    expect(await judge(mail, "[evaluation:2:a]")).toEqual({ status: "unavailable", reason: "The evaluator has not answered yet." });
    expect(mail.sends).toHaveLength(1);
  });

  test("a failed send throws with its reason", async () => {
    const mail = fakeMail();
    mail.failNextSend();
    await expect(judge(mail, "[evaluation:2:a]")).rejects.toThrow("409 run released");
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
