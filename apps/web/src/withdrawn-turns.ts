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

/** The marker artifact's content: `JSON.parse`d and reread on every load. */
export function parseWithdrawnTurns(content: string | null | undefined): WithdrawnMark[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { withdrawn?: unknown };
    return Array.isArray(parsed.withdrawn) ? (parsed.withdrawn as WithdrawnMark[]) : [];
  } catch {
    return [];
  }
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
 * Pairs each agent reply with the person turn it answers by FIFO order —
 * one mail-triggered step at a time, draining the specialist's inbox in the
 * order it arrived. Never by `inReplyTo`: `ChatMessage.id` is a mailbox
 * folder position (`"Sent:<uid>"`/`"INBOX:<uid>"`), not the RFC Message-ID
 * `inReplyTo` actually names, so the two can never match.
 *
 * An agent message that arrives with nothing queued (the stage's opening
 * reply, or an unsolicited message) answers nothing and is never paired.
 */
export function pairReplies(messages: readonly ChatMessage[]): ReplyPairing {
  const queue: ChatMessage[] = [];
  const answeredBy = new Map<string, string>();
  for (const message of messages) {
    if (message.author === "me") {
      queue.push(message);
      continue;
    }
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
