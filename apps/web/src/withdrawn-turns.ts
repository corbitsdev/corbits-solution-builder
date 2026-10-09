/**
 * Stop, for a mail-chat stage: a person's turn is withdrawn before the
 * specialist's reply to it is ever read. The reply itself is never
 * cancelled — mail has no such thing — so the marker recorded here is what
 * keeps that late answer from being recorded as if it had been read (CL-8695).
 */
import type { ChatMessage } from "./stage-mail.ts";

/** The artifact kind a project's withdrawn-turn marker is recorded under. */
export const WITHDRAWN_TURNS_KIND = "withdrawn_turns";

export type WithdrawnMark = {
  readonly messageId: string;
  readonly stage: number;
  readonly at: string;
};

/**
 * The marker artifact's content, reread on every load. Empty is no marks;
 * anything else that is not the marker's own shape throws, never reads as
 * no marks (#570): a mark read as absent lets the stopped turn's reply back
 * in, and a Stop recorded over it would drop every earlier one.
 */
export function parseWithdrawnTurns(content: string | null | undefined): WithdrawnMark[] {
  if (!content || content.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The withdrawn-turn marker is not valid JSON.");
  }
  const withdrawn = (parsed as { withdrawn?: unknown } | null)?.withdrawn;
  if (!Array.isArray(withdrawn)) throw new Error("The withdrawn-turn marker does not hold a list of withdrawn turns.");
  return withdrawn as WithdrawnMark[];
}

export function withdrawnTurnsContent(marks: readonly WithdrawnMark[]): string {
  return JSON.stringify({ withdrawn: marks });
}

export type ReplyPairing = {
  /** Agent message id -> the person message id it answers. */
  readonly answeredBy: ReadonlyMap<string, string>;
  /** Person messages not yet answered, oldest first. */
  readonly queue: readonly ChatMessage[];
};

/**
 * Pairs each agent reply with the person turn it answers.
 *
 * By id first (#62): the hub mints a Message-ID for the mail it delivers to
 * the run and records it on the person's Sent copy (`triggerMessageId`), and
 * the run's reply names that id in `inReplyTo`. A reply whose `inReplyTo`
 * names a turn in `messages` is that turn's answer, wherever either sits.
 * `ChatMessage.id` itself is a folder position (`"Sent:<uid>"`), never what
 * `inReplyTo` names, so it plays no part.
 *
 * By order for the rest: one mail-triggered step at a time, draining the
 * specialist's inbox in the order it arrived, over the turns and replies the
 * id pass left unpaired. That is what a turn sent before the trigger id was
 * recorded, or a reply carrying no usable `inReplyTo`, falls back on.
 *
 * An agent message that arrives with nothing queued (the stage's opening
 * reply, or an unsolicited message) answers nothing and is never paired.
 */
export function pairReplies(messages: readonly ChatMessage[]): ReplyPairing {
  const answeredBy = new Map<string, string>();
  const byTriggerId = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.author === "me" && message.triggerMessageId !== undefined) {
      byTriggerId.set(message.triggerMessageId, message);
    }
  }
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.author !== "agent" || message.inReplyTo === undefined) continue;
    const request = byTriggerId.get(message.inReplyTo);
    if (request === undefined || answered.has(request.id)) continue;
    answeredBy.set(message.id, request.id);
    answered.add(request.id);
  }
  const queue: ChatMessage[] = [];
  for (const message of messages) {
    if (message.author === "me") {
      if (!answered.has(message.id)) queue.push(message);
      continue;
    }
    if (answeredBy.has(message.id)) continue;
    const head = queue.shift();
    if (head) answeredBy.set(message.id, head.id);
  }
  return { answeredBy, queue };
}

/**
 * Hides the specialist reply paired with a withdrawn person turn. The
 * withdrawn person turn itself is kept — a caller greys it out using the
 * same `withdrawnIds` set, rather than a flag this fold would have to invent.
 *
 * Applied before `workspaceGuidance` ever sees the thread, so a hidden reply
 * can never be read back as the current draft or the open question.
 */
export function applyWithdrawn(
  messages: readonly ChatMessage[],
  withdrawnIds: ReadonlySet<string>,
): ChatMessage[] {
  if (withdrawnIds.size === 0) return [...messages];
  const { answeredBy } = pairReplies(messages);
  const hidden = new Set<string>();
  for (const [agentId, personId] of answeredBy) {
    if (withdrawnIds.has(personId)) hidden.add(agentId);
  }
  return messages.filter((message) => !hidden.has(message.id));
}

/**
 * The person turn a Stop button can act on: the oldest turn still waiting
 * on a reply once every earlier turn has been paired off — normally the
 * latest person message, since the specialist answers one step at a time.
 * Null once that turn is already withdrawn, so an already-stopped turn
 * never offers Stop again.
 */
export function pendingTurn(
  messages: readonly ChatMessage[],
  withdrawnIds: ReadonlySet<string>,
): ChatMessage | null {
  const { queue } = pairReplies(messages);
  const head = queue[0];
  if (!head || withdrawnIds.has(head.id)) return null;
  return head;
}
