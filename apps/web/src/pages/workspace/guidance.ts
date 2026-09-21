import type { ChatMessage } from "../../stage-mail.ts";
import { choicesIn } from "./choices.ts";

export type InterviewQuestion = {
  readonly text: string;
  readonly choices: readonly string[];
};

export type WorkspaceGuidance = {
  readonly title: string;
  readonly detail: string;
  readonly question: InterviewQuestion | null;
  /**
   * A substantial specialist message suitable to read as a draft. This is not
   * a readiness verdict and never authorizes approval.
   */
  readonly draft: ChatMessage | null;
  /**
   * A one-line note shown once a substantial draft exists and nothing more is
   * being asked. Advisory only — it never authorizes approval.
   */
  readonly readyNote: string | null;
};

export type InterviewProgress = {
  /** The question now open, counting every specialist question already
   *  answered in this thread before it. */
  readonly ordinal: number;
  /** Only set when the specialist's own text states how many there are. */
  readonly total: number | null;
};

/**
 * "Question N of M" while a specialist is interviewing. N counts the
 * specialist questions already answered in this thread, plus the one now
 * open; M is shown only when the specialist's own text states a total, and
 * only when that total is not already exceeded.
 */
export function interviewProgress(messages: readonly ChatMessage[]): InterviewProgress | null {
  const current = latestAgent(messages);
  if (!current || !questionIn(current.body)) return null;
  const answered = messages.filter(
    (message) => message.author === "agent" && message.id !== current.id && questionIn(message.body) !== null,
  ).length;
  const ordinal = answered + 1;
  const stated = /(\d+)\s+questions?\b/i.exec(current.body) ?? /\bof\s+(\d+)\b/i.exec(current.body);
  const total = stated ? Number(stated[1]) : null;
  return { ordinal, total: total !== null && total >= ordinal ? total : null };
}

const PURPOSE: Record<number, string> = {
  1: "Clarify the problem, who is affected, and observable success.",
  2: "Record the constraints, risks, and non-goals that shape the work.",
  3: "Compare approaches and make the selection explicit.",
  4: "Review the proposed experience and give contextual feedback.",
  5: "Collect the audience decisions needed to align the work.",
  6: "Check that the plan covers the approved work and its verification.",
  7: "Choose the target and review the estimate and its uncertainty.",
  8: "Review execution evidence and address real tool-permission requests.",
  9: "Verify the delivery evidence and decide whether it is acceptable.",
};

/**
 * A mail reply may be an acknowledgement, a question, or a draft. A reply is
 * only promoted into the draft pane when it has enough concrete content to
 * read as one. The threshold deliberately does not decide readiness: a draft
 * with missing information remains a draft for the person to correct.
 */
export function isSubstantialDraft(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length < 240) return false;
  const headings = trimmed.match(/^#{1,3}\s+\S.+$/gm) ?? [];
  const prose = trimmed
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return headings.length >= 2 && prose.length >= 200;
}

function questionIn(body: string): InterviewQuestion | null {
  const choices = choicesIn(body);
  if (choices) return { text: choices.question, choices: choices.options };

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last || !last.endsWith("?")) return null;
  return { text: last, choices: [] };
}

function latestAgent(messages: readonly ChatMessage[]): ChatMessage | null {
  return [...messages].reverse().find((message) => message.author === "agent") ?? null;
}

/** The latest complete-looking draft, retained when a later agent turn is
 * only an acknowledgement or a follow-up question. */
export function latestSubstantialDraft(messages: readonly ChatMessage[]): ChatMessage | null {
  return [...messages].reverse().find((message) => message.author === "agent" && isSubstantialDraft(message.body)) ?? null;
}

export type EvaluatorVerdict = {
  readonly ready: boolean;
  readonly notes: readonly string[];
};

/**
 * Stage 1's brief evaluator replies with a fixed "Verdict: ready" or
 * "Verdict: not yet" line, then up to five bullets. Advisory only — this
 * never feeds the approve gate, which reads `workflowView.allowed.approve`.
 */
export function evaluatorVerdict(messages: readonly ChatMessage[]): EvaluatorVerdict | null {
  const latest = latestAgent(messages);
  if (!latest) return null;
  const match = /^Verdict:\s*(ready|not yet)\s*$/im.exec(latest.body);
  if (!match) return null;
  const notes = latest.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""));
  return { ready: match[1]!.toLowerCase() === "ready", notes };
}

/**
 * A read-only projection from the mail thread. It intentionally never infers
 * whether a stage is approved, progressing, or complete.
 */
export function workspaceGuidance(stage: number, messages: readonly ChatMessage[]): WorkspaceGuidance {
  const purpose = PURPOSE[stage] ?? "Review the available evidence and identify the next human decision.";
  const latest = latestAgent(messages);
  const draft = latestSubstantialDraft(messages);
  const question = latest ? questionIn(latest.body) : null;

  if (question) {
    return {
      title: "Your input is needed",
      detail: [purpose, "Answer the specialist's recorded question; “I’m not sure” is a valid answer."].join(" "),
      question,
      draft,
      readyNote: null,
    };
  }
  if (draft) {
    return {
      title: "Review the current draft",
      detail: [purpose, "The latest substantial draft is available beside the conversation. Request a correction if it does not reflect the decision you want to make."].join(" "),
      question: null,
      draft,
      readyNote: "This draft is substantial and nothing more is being asked: it looks ready for your approval.",
    };
  }
  if (latest) {
    return {
      title: "A reply needs clarification",
      detail: [purpose, "A specialist reply is recorded, but it is not identifiable as a complete draft. Ask for the complete stage draft or provide the missing detail."].join(" "),
      question: null,
      draft: null,
      readyNote: null,
    };
  }
  if (messages.length > 0) {
    return {
      title: "Waiting for a reply",
      detail: [purpose, "Your message is recorded; no specialist reply is visible in this thread yet."].join(" "),
      question: null,
      draft: null,
      readyNote: null,
    };
  }
  return {
    title: "Start the conversation",
    detail: [purpose, "No message is recorded for this stage yet."].join(" "),
    question: null,
    draft: null,
    readyNote: null,
  };
}

