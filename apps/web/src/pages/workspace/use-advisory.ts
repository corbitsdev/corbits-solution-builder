/**
 * The workspace's two advisory agents. Neither ever writes an artifact or
 * touches the approve gate, and both say so when they cannot answer:
 * unavailable is a state the person sees, never a silence.
 *
 * A stage's draft evaluator (CL-8736 for stage 1's brief evaluator): its own
 * deployment (`api.ensureEvaluatorAgent`), mailed each new draft with the
 * record the stage opened on; its reply is read back as an advisory verdict
 * beside the approve control. Its notes go to the stage specialist as one
 * revision (`evaluatorRevisionDue`), once per draft and at most
 * `EVALUATOR_ROUNDS` times per stage.
 *
 * The Product guide (CL-8737): calm orientation across the nine stages,
 * asked for rather than shown, through its own deployment
 * (`api.ensureGuideAgent`). It is handed the project's live versions and
 * recorded decisions (`product-guide.ts`). When it cannot answer, the
 * checklist computed from the workflow view is shown, with why.
 *
 * A reply is matched to the request it answers by the trigger id its
 * `In-Reply-To` names (`pairReplies`, #62). A request whose delivery failed
 * but left a Sent row (#61) carries no trigger id, so nothing ever pairs
 * with it.
 *
 * The work itself is in `judgeDraft` and `askGuide`, written against
 * `AdvisoryDeps` so they run without React; the hooks only bind them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { keys } from "../../queries/keys.ts";
import { api, ApiFailure } from "../../client.js";
import type { ArtifactNode } from "../../client.js";
import { evaluatorFor } from "@solutions-builder/app/kit";
import { STAGE_TITLES, type Stage } from "@solutions-builder/app/ledger";
import { classifierRequest, evaluationRequest, evaluatorNotesAsk } from "@solutions-builder/app/stage-prompt";
import { evaluationTag, evaluatorNotesSubject, isEvaluatorNotes } from "./composed-mail.ts";
import type { GuideGuidance } from "../../components.jsx";
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
/** How long after "not answered yet" the evaluator's thread is read again. */
const LATE_VERDICT_MS = 30_000;
/** How long a reply may take before the person is told it has not come. A
 *  local model drafting a verdict or an orientation routinely needs well over
 *  a minute. Counted from when the request was sent. */
export const REPLY_BUDGET_MS = 180_000;

/** What the two agents need from the app, injectable so the logic runs in a test. */
export type AdvisoryDeps = {
  readonly ensureEvaluator: (projectId: string, stage: Stage) => Promise<{ address: string }>;
  readonly ensureGuide: (projectId: string) => Promise<{ address: string }>;
  readonly readThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
  readonly sendMail: (tenantId: string, address: string, input: { body: string; subject: string }) => Promise<void>;
  readonly artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
};

const liveDeps: AdvisoryDeps = {
  ensureEvaluator: (projectId, stage) => api.ensureEvaluatorAgent(projectId, stage),
  ensureGuide: (projectId) => api.ensureGuideAgent(projectId),
  readThread: (tenantId, addresses) => api.readStageThread(tenantId, addresses),
  sendMail: (tenantId, address, input) => api.sendStageMail(tenantId, address, input),
  artifactContent: (tenantId, nodeId) => api.artifactContent(tenantId, nodeId),
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

type Answer = { readonly request: ChatMessage; readonly reply: ChatMessage | null };

/**
 * The latest request in `thread` that `isRequest` picks, and the reply
 * paired with it (null while unanswered). Null when no such request was
 * sent.
 */
function answerWhere(thread: readonly ChatMessage[], isRequest: (message: ChatMessage) => boolean): Answer | null {
  const request = thread.findLast((message) => message.author === "me" && isRequest(message));
  if (!request) return null;
  const { answeredBy } = pairReplies(thread);
  const reply = thread.find((message) => message.author === "agent" && answeredBy.get(message.id) === request.id) ?? null;
  return { request, reply };
}

/** The answer to the latest request whose body is `requestBody`. */
export function answerTo(thread: readonly ChatMessage[], requestBody: string): Answer | null {
  return answerWhere(thread, (message) => sameText(message.body, requestBody));
}

/** The answer to the latest request sent under `tag` in its subject. */
export function taggedAnswer(thread: readonly ChatMessage[], tag: string): Answer | null {
  return answerWhere(thread, (message) => message.subject?.startsWith(tag) === true);
}

export type StageEvaluator =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "verdict"; readonly verdict: EvaluatorVerdict }
  | { readonly status: "unavailable"; readonly reason: string };

const IDLE: StageEvaluator = { status: "idle" };
const CHECKING: StageEvaluator = { status: "checking" };

/** A classifier's reply is the System One decision it was asked for, as JSON: its probability, or null. */
function classifierScore(body: string): number | null {
  let decision: unknown;
  try {
    decision = JSON.parse(body);
  } catch {
    return null;
  }
  const noul = typeof decision === "object" && decision !== null ? (decision as { noul?: unknown }).noul : undefined;
  return typeof noul === "number" ? noul : null;
}

/** The state an evaluator reply puts the verdict in; `readyAt` is set when the evaluator is a classifier. */
export function evaluatorStateOf(reply: ChatMessage, readyAt: number | null = null): StageEvaluator {
  if (readyAt !== null) {
    const score = classifierScore(reply.body.trim());
    return score === null
      ? { status: "unavailable", reason: `The classifier gave no score: ${firstLine(reply.body)}` }
      : { status: "verdict", verdict: { ready: score >= readyAt, notes: [], score } };
  }
  const verdict = evaluatorVerdict([reply]);
  return verdict
    ? { status: "verdict", verdict }
    : { status: "unavailable", reason: `The evaluator could not judge this draft: ${firstLine(reply.body)}` };
}

/**
 * Has a stage's evaluator judge one draft, and waits for its verdict. The
 * request carries the draft's tag in its subject, so one already sent (a
 * reload, a second tab) is read, never sent again. The budget counts from
 * the send; a verdict later than that is found by the next read. A failed
 * deploy, read or send throws.
 */
export async function judgeDraft(
  deps: AdvisoryDeps,
  input: {
    readonly projectId: string;
    readonly tenantId: string;
    readonly stage: Stage;
    readonly tag: string;
    readonly body: string;
    readonly signal: AbortSignal;
    /** Set when the evaluator is a classifier: the score it must reach. */
    readonly readyAt?: number | null;
  },
): Promise<StageEvaluator> {
  const { projectId, tenantId, stage, tag, body, signal, readyAt = null } = input;
  const { address } = await deps.ensureEvaluator(projectId, stage);
  let answer = taggedAnswer(await deps.readThread(tenantId, [address]), tag);
  if (!answer) {
    await deps.sendMail(tenantId, address, { body, subject: `${tag} Stage ${stage} draft for review` });
    answer = taggedAnswer(await deps.readThread(tenantId, [address]), tag);
  }
  const deadline = (answer ? Date.parse(answer.request.at) : deps.now()) + REPLY_BUDGET_MS;
  while (!answer?.reply) {
    if (deps.now() >= deadline) return { status: "unavailable", reason: "The evaluator has not answered yet." };
    await deps.wait(POLL_MS);
    signal.throwIfAborted();
    answer = taggedAnswer(await deps.readThread(tenantId, [address]), tag);
  }
  return evaluatorStateOf(answer.reply, readyAt);
}

/**
 * The verdict of the stage's evaluator on the current draft, handed with the
 * record the stage opened on (stage 1's brief evaluator judges the page
 * alone, as it always has). A draft is new when its text is: a reply that
 * leaves the document as it was is not judged again. Idle on a stage no
 * evaluator reads.
 */
export function useStageEvaluator(
  projectId: string,
  tenantId: string,
  stage: Stage,
  draft: string | null,
  record: string | null,
): StageEvaluator {
  const classifier = useQuery({ queryKey: keys.classifier.all, queryFn: () => api.classifier() });
  const tag = draft !== null && evaluatorFor(stage) !== null ? evaluationTag(stage, draft) : null;
  const scorer = classifier.data ?? null;
  const query = useQuery({
    queryKey: keys.evaluation.of(projectId, `${tag ?? ""}${scorer ? `:${scorer.offeringId}:${scorer.readyAt}` : ""}`),
    queryFn: ({ signal }) =>
      judgeDraft(liveDeps, {
        projectId,
        tenantId,
        stage,
        tag: tag ?? "",
        body: scorer
          ? classifierRequest(STAGE_TITLES[stage], draft ?? "")
          : stage === 1
            ? (draft ?? "")
            : evaluationRequest({ record, draft: draft ?? "" }),
        signal,
        readyAt: scorer?.readyAt ?? null,
      }),
    enabled: tag !== null && classifier.isSuccess,
    staleTime: Number.POSITIVE_INFINITY,
    // "Not answered yet" is looked at again: a slow model's verdict replaces it.
    refetchInterval: (current) => (current.state.data?.status === "unavailable" ? LATE_VERDICT_MS : false),
  });
  if (tag === null) return IDLE;
  if (classifier.error) return { status: "unavailable", reason: `Which evaluator to ask could not be read: ${reasonOf(classifier.error)}` };
  if (query.error) return { status: "unavailable", reason: `The evaluator could not be reached: ${reasonOf(query.error)}` };
  return query.data ?? CHECKING;
}

/** Automatic revision rounds a stage's evaluator gets; after them the person decides. */
export const EVALUATOR_ROUNDS = 2;

/** Whether the evaluator may still send the specialist a revision round this stage. */
export function evaluatorRoundLeft(messages: readonly ChatMessage[]): boolean {
  return messages.filter(isEvaluatorNotes).length < EVALUATOR_ROUNDS;
}

/**
 * The subject to send the evaluator's notes on `draft` under, when they are
 * owed to the specialist now; null when not. They are owed on any draft the
 * evaluator holds back, once the specialist has answered and while the
 * stage has a round left.
 */
export function evaluatorRevisionDue(args: {
  readonly stage: number;
  readonly evaluator: StageEvaluator;
  readonly draft: string | null;
  readonly messages: readonly ChatMessage[];
}): string | null {
  const { stage, evaluator, draft, messages } = args;
  if (stage === 1 || draft === null) return null;
  if (evaluator.status !== "verdict" || evaluator.verdict.ready || evaluator.verdict.notes.length === 0) return null;
  if (messages.at(-1)?.author !== "agent" || !evaluatorRoundLeft(messages)) return null;
  return evaluatorNotesSubject(stage, draft);
}

/**
 * Sends the evaluator's notes to the specialist as one revision request when
 * `evaluatorRevisionDue` says they are owed; `send` composes and mails it,
 * standing down when the subject was already sent. Returns why the notes
 * could not be sent, or null.
 */
export function useEvaluatorRevision(
  args: Parameters<typeof evaluatorRevisionDue>[0] & { readonly send: (ask: string, subject: string) => Promise<void> },
): string | null {
  const subject = evaluatorRevisionDue(args);
  const notes = args.evaluator.status === "verdict" ? args.evaluator.verdict.notes : [];
  const query = useQuery({
    queryKey: keys.evaluatorNotes.of(subject ?? ""),
    queryFn: async () => {
      await args.send(evaluatorNotesAsk(notes), subject ?? "");
      return subject;
    },
    enabled: subject !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return query.error ? reasonOf(query.error) : null;
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
