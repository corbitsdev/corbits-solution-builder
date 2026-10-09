/**
 * Marks a stage's agent replies read once the chat has them on screen
 * (#834). The read flag is the server's, so the bell's Activity row for
 * this project and stage clears on every device, not just this tab. Only
 * the thread the chat shows is marked: a reply in another stage stays
 * unread until that stage's chat is viewed.
 *
 * There is no bulk route, so one request per reply. A failed mark is said
 * once per reply and tried again on the next thread read; the row then
 * stays in the bell until a mark lands, which is the honest state.
 */
import { useEffect, useRef } from "react";
import { api, ApiFailure } from "../../client.js";
import { queryClient } from "../../queries/client.ts";
import { keys } from "../../queries/keys.ts";
import type { ChatMessage } from "../../stage-mail.ts";

export type UnreadReply = { readonly id: string; readonly mailTenantId: string; readonly uid: number };

/** The replies in `messages` still to mark read, skipping `exclude`: unread
 * agent turns whose mailbox and uid are known. The uid is the id's second
 * half (`INBOX:<uid>`, `readStageThread`). */
export function repliesToMarkRead(messages: readonly ChatMessage[], exclude: ReadonlySet<string> = new Set()): UnreadReply[] {
  const found: UnreadReply[] = [];
  for (const message of messages) {
    if (message.author !== "agent" || !message.unread || !message.mailTenantId || exclude.has(message.id)) continue;
    const uid = Number(message.id.split(":")[1]);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    found.push({ id: message.id, mailTenantId: message.mailTenantId, uid });
  }
  return found;
}

export function useMarkRepliesRead(
  messages: readonly ChatMessage[],
  onError: (message: string) => void,
  markRead: (mailTenantId: string, uid: number) => Promise<void> = api.markStageReplyRead,
): void {
  // Replies marked or in flight, so a re-render never sends the same mark twice.
  const marked = useRef(new Set<string>());
  const reported = useRef(new Set<string>());
  useEffect(() => {
    const pending = repliesToMarkRead(messages, marked.current);
    if (pending.length === 0) return;
    for (const reply of pending) marked.current.add(reply.id);
    void Promise.all(
      pending.map((reply) =>
        markRead(reply.mailTenantId, reply.uid).catch((cause: unknown) => {
          marked.current.delete(reply.id);
          if (reported.current.has(reply.id)) return;
          reported.current.add(reply.id);
          onError(`A reply could not be marked read: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
        }),
      ),
    ).then(() => queryClient.invalidateQueries({ queryKey: keys.activity }));
  }, [messages, markRead, onError]);
}
