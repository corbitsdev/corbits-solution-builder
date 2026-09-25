/**
 * The workspace's two advisory agents. Neither ever writes an artifact or
 * touches the approve gate, and both say so when they cannot answer:
 * unavailable is a state the person sees, never a silence.
 *
 * Stage 1's brief evaluator (CL-8736): its own deployment
 * (`api.ensureStage1EvaluatorAgent`), mailed a copy of each new draft; its
 * reply is read back as an advisory verdict beside the approve control.
 *
 * The Product guide (CL-8737): calm orientation across the nine stages,
 * asked for rather than shown, through its own deployment
 * (`api.ensureGuideAgent`). It is handed the project's live versions and
 * recorded decisions (`product-guide.ts`). When it cannot answer, the
 * checklist computed from the workflow view is shown, with why.
 *
 * A reply is matched to the request it answers by queue order
 * (`pairReplies`): the n-th reply answers the n-th request. Mail offers
 * nothing better today, because the hub stamps a reply with its own delivery
 * id rather than the sent mail's Message-ID (#62). Queue order holds only
 * while every delivered request gets exactly one reply and the thread read
 * back is complete: a request whose delivery failed but left a Sent row
 * (#61), or a thread cut unevenly by the mailbox's page size, shifts every
 * later pairing by one.
 *
 * The work itself is in `watchEvaluator` and `askGuide`, written against
 * `AdvisoryDeps` so they run without React; the hooks only bind them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import type { ArtifactNode } from "../../client.js";
import type { GuideGuidance } from "../../components.jsx";
import { subscribeMailbox } from "../../mailbox-events.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import { pairReplies } from "../../withdrawn-turns.ts";
import { evaluatorVerdict, type EvaluatorVerdict } from "./guidance.js";
import {
  budgetVersions,
  deterministicGuidance,
  guidancePrompt,
  guideVersionNodes,
  parseGuidanceReply,
  type GuideContext,
  type GuideVersion,
} from "./product-guide.js";

/** How often the guide looks for its answer while a person waits on it. */
export const POLL_MS = 3_000;
/** The evaluator's backstop when the mailbox stream is quiet or closed. */
export const BACKSTOP_MS = 10_000;
/** How long a reply may take before the person is told it has not come. A
 *  local model drafting a verdict or an orientation routinely needs well over
 *  a minute. Counted from when the request was sent. */
export const REPLY_BUDGET_MS = 180_000;
/** Consecutive failures before a state says so. */
const TOLERATED_FAILURES = 3;

/** What the two agents need from the app, injectable so the logic runs in a test. */
export type AdvisoryDeps = {
  readonly ensureEvaluator: (projectId: string) => Promise<{ address: string }>;
  readonly ensureGuide: (projectId: string) => Promise<{ address: string }>;
  readonly readThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
  readonly sendMail: (tenantId: string, address: string, input: { body: string; subject: string }) => Promise<void>;
  readonly artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  readonly subscribe: (tenantId: string, onNudge: () => void) => { unsubscribe(): void };
  /** Runs `fn` every `ms`; returns what stops it. */
  readonly every: (ms: number, fn: () => void) => () => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
};

const liveDeps: AdvisoryDeps = {
  ensureEvaluator: (projectId) => api.ensureStage1EvaluatorAgent(projectId),
  ensureGuide: (projectId) => api.ensureGuideAgent(projectId),
  readThread: (tenantId, addresses) => api.readStageThread(tenantId, addresses),
  sendMail: (tenantId, address, input) => api.sendStageMail(tenantId, address, input),
  artifactContent: (tenantId, nodeId) => api.artifactContent(tenantId, nodeId),
  subscribe: (tenantId, onNudge) => subscribeMailbox(tenantId, onNudge),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function reasonOf(cause: unknown): string {
  if (cause instanceof ApiFailure) return cause.detail.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** A reply's first line, for saying what an agent answered instead. */
function firstLine(body: string): string {
  const line = body.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

const sameText = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

/**
 * The latest request in `thread` whose body is `requestBody`, and the reply
 * paired with it by queue order (null while unanswered). Null when no such
 * request was sent. See the header for when queue order can mislead.
 */
export function answerTo(
  thread: readonly ChatMessage[],
  requestBody: string,
): { readonly request: ChatMessage; readonly reply: ChatMessage | null } | null {
  const request = [...thread].reverse().find((message) => message.author === "me" && sameText(message.body, requestBody));
  if (!request) return null;
  const { answeredBy } = pairReplies(thread);
  const reply = thread.find((message) => message.author === "agent" && answeredBy.get(message.id) === request.id) ?? null;
  return { request, reply };
}

export type StageEvaluator =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "verdict"; readonly verdict: EvaluatorVerdict }
  | { readonly status: "unavailable"; readonly reason: string };

/** The state an evaluator reply puts the verdict in. */
export function evaluatorStateOf(reply: ChatMessage): StageEvaluator {
  const verdict = evaluatorVerdict([reply]);
  return verdict
    ? { status: "verdict", verdict }
    : { status: "unavailable", reason: `The brief evaluator could not judge this draft: ${firstLine(reply.body)}` };
}

/**
 * Has the brief evaluator judge one draft, reporting each state it passes
 * through. The draft is mailed once: one already sent (a reload, coming back
 * to stage 1) is read, not re-sent. A failed deploy or read is retried on the
 * next wake. A failed send is reported with its reason at once, and that
 * reason stays shown until a reply pairs: the mailbox may keep the Sent copy
 * of an undelivered request (#61), so finding the request later does not mean
 * it arrived. It wakes on mailbox events and a backstop timer, and closes both
 * once the reply is in. Returns what stops it.
 */
export function watchEvaluator(
  deps: AdvisoryDeps,
  input: { readonly projectId: string; readonly tenantId: string; readonly body: string },
  report: (state: StageEvaluator) => void,
): () => void {
  const { projectId, tenantId, body } = input;
  let stopped = false;
  let busy = false;
  let again = false;
  let address: string | null = null;
  let deadline = Number.POSITIVE_INFINITY;
  let failures = 0;
  let failing = false;
  let timedOut = false;
  // Why the request's send failed, kept until a reply shows it did arrive.
  let sendFailure: string | null = null;
  const closers: (() => void)[] = [];
  const emit = (state: StageEvaluator) => {
    if (!stopped) report(state);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const close of closers) close();
  };
  const failed = (reason: string) => {
    failures += 1;
    if (failures >= TOLERATED_FAILURES) {
      failing = true;
      emit({ status: "unavailable", reason });
    }
  };
  const recovered = () => {
    failures = 0;
    if (failing) {
      failing = false;
      emit(sendFailure ? { status: "unavailable", reason: sendFailure } : { status: "checking" });
    }
  };
  const settleFrom = (thread: readonly ChatMessage[]) => {
    const reply = answerTo(thread, body)?.reply ?? null;
    if (reply) {
      emit(evaluatorStateOf(reply));
      stop();
    } else if (!sendFailure && !timedOut && deps.now() >= deadline) {
      // Said once; a slow model's verdict still replaces it.
      timedOut = true;
      emit({ status: "unavailable", reason: "The brief evaluator has not answered yet." });
    }
  };

  const start = async () => {
    let deployed: string;
    let thread: ChatMessage[];
    try {
      deployed = (await deps.ensureEvaluator(projectId)).address;
      thread = await deps.readThread(tenantId, [deployed]);
    } catch (cause) {
      failed(`The brief evaluator could not be reached: ${reasonOf(cause)}`);
      return;
    }
    if (stopped) return;
    const earlier = answerTo(thread, body);
    if (earlier) {
      recovered();
      address = deployed;
      const sentAt = Date.parse(earlier.request.at);
      deadline = (Number.isFinite(sentAt) ? sentAt : deps.now()) + REPLY_BUDGET_MS;
      settleFrom(thread);
      return;
    }
    try {
      await deps.sendMail(tenantId, deployed, { body, subject: "Stage 1 draft for review" });
    } catch (cause) {
      // Shown now, not after retries: a send is not re-tried blindly, since a
      // failed one can still leave its Sent copy, which the next wake finds.
      sendFailure = `The brief evaluator could not be reached: ${reasonOf(cause)}`;
      emit({ status: "unavailable", reason: sendFailure });
      return;
    }
    const hadFailed = sendFailure !== null;
    sendFailure = null;
    recovered();
    if (hadFailed) emit({ status: "checking" });
    address = deployed;
    deadline = deps.now() + REPLY_BUDGET_MS;
  };

  const check = async (at: string) => {
    let thread: ChatMessage[];
    try {
      thread = await deps.readThread(tenantId, [at]);
    } catch (cause) {
      failed(`The brief evaluator's reply could not be read: ${reasonOf(cause)}`);
      return;
    }
    if (stopped) return;
    recovered();
    settleFrom(thread);
  };

  // One step at a time; a wake that arrives mid-step runs again right after,
  // rather than waiting for the backstop.
  const wake = async () => {
    if (stopped) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        if (address === null) await start();
        else await check(address);
      } while (again && !stopped);
    } finally {
      busy = false;
    }
  };

  emit({ status: "checking" });
  const subscription = deps.subscribe(tenantId, () => void wake());
  closers.push(() => subscription.unsubscribe());
  closers.push(deps.every(BACKSTOP_MS, () => void wake()));
  void wake();
  return stop;
}

/**
 * Asks the brief evaluator about each new stage 1 draft, and reports the
 * reply to that draft's request.
 */
export function useStageEvaluator(projectId: string, tenantId: string, stage: number, draftMessage: ChatMessage | null): StageEvaluator {
  const [state, setState] = useState<StageEvaluator>({ status: "idle" });
  const draftId = stage === 1 ? (draftMessage?.id ?? null) : null;
  // The body of the draft being judged, read when its watch starts without
  // re-running the effect when only unrelated fields of the message change.
  const bodyRef = useRef(draftMessage?.body ?? "");
  bodyRef.current = draftMessage?.body ?? "";

  useEffect(() => {
    if (draftId === null) {
      setState({ status: "idle" });
      return;
    }
    return watchEvaluator(liveDeps, { projectId, tenantId, body: bodyRef.current }, setState);
  }, [draftId, projectId, tenantId]);

  return state;
}

/** Reads the versions the guide is handed, and keeps what fits its budget. */
async function readVersions(deps: AdvisoryDeps, tenantId: string, nodes: readonly ArtifactNode[], stage: number): Promise<GuideVersion[]> {
  const read = await Promise.all(
    guideVersionNodes(nodes, stage).map(async (node) => ({
      id: node.id,
      title: node.title,
      stage: node.stage,
      kind: node.kind,
      content: (await deps.artifactContent(tenantId, node.id).catch(() => ({ content: "" }))).content,
    })),
  );
  return budgetVersions(read);
}

export type GuideAnswer = { readonly guidance: GuideGuidance; readonly note: string | null };

/**
 * Asks the guide once: reads the project's versions, mails the request and
 * waits up to `REPLY_BUDGET_MS` from the send for its paired reply. Returns
 * the guide's answer, or the checklist with why; null once `live` says the
 * ask no longer matters.
 */
export async function askGuide(
  deps: AdvisoryDeps,
  input: { readonly tenantId: string; readonly projectId: string; readonly context: GuideContext },
  live: () => boolean,
): Promise<GuideAnswer | null> {
  const { tenantId, projectId, context } = input;
  const floor = deterministicGuidance(context);
  try {
    const versions = await readVersions(deps, tenantId, context.nodes, context.stage);
    const address = (await deps.ensureGuide(projectId)).address;
    if (!live()) return null;
    const prompt = guidancePrompt(context, versions);
    await deps.sendMail(tenantId, address, { body: prompt, subject: "Guidance request" });
    const deadline = deps.now() + REPLY_BUDGET_MS;
    while (live()) {
      await deps.wait(POLL_MS);
      if (!live()) return null;
      const reply = answerTo(await deps.readThread(tenantId, [address]), prompt)?.reply ?? null;
      if (reply) {
        const parsed = parseGuidanceReply(reply.body, versions);
        return parsed ? { guidance: parsed, note: null } : { guidance: floor, note: `The guide could not answer: ${firstLine(reply.body)}` };
      }
      if (deps.now() >= deadline) return { guidance: floor, note: "The guide has not answered. Ask again in a moment." };
    }
    return null;
  } catch (cause) {
    return live() ? { guidance: floor, note: `The guide could not be reached: ${reasonOf(cause)}` } : null;
  }
}

export type ProductGuideState = {
  /** Null until the person asks; then the guide's answer, or the checklist
   *  when it gave none. */
  readonly guidance: GuideGuidance | null;
  readonly explaining: boolean;
  /** Why the guide gave no answer, shown beside the checklist. */
  readonly note: string | null;
  readonly explain: () => Promise<void>;
};

export function useProductGuide(tenantId: string, projectId: string, context: GuideContext): ProductGuideState {
  const [answer, setAnswer] = useState<(GuideAnswer & { stage: number }) | null>(null);
  const [explaining, setExplaining] = useState(false);
  const contextRef = useRef(context);
  contextRef.current = context;
  // Bumped whenever an in-flight ask stops mattering: a stage or project
  // change, a newer ask, or unmount. An ask whose token is stale says nothing.
  const request = useRef(0);

  useEffect(() => {
    request.current += 1;
    setAnswer(null);
    setExplaining(false);
  }, [context.stage, projectId]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const explain = useCallback(async () => {
    const token = (request.current += 1);
    const live = () => request.current === token;
    const asked = contextRef.current;
    setExplaining(true);
    const result = await askGuide(liveDeps, { tenantId, projectId, context: asked }, live);
    if (!live()) return;
    if (result) setAnswer({ ...result, stage: asked.stage });
    setExplaining(false);
  }, [projectId, tenantId]);

  const current = answer && answer.stage === context.stage ? answer : null;
  return { guidance: current?.guidance ?? null, explaining, note: current?.note ?? null, explain };
}
