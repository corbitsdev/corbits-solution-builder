/**
 * The mailbox inbox, kept live over `@corbits/mailbox`'s SSE stream.
 *
 * `@corbits/mailbox` is mounted on embed-hub under `/me/inbox*` (see PR #332),
 * reachable from the browser at `/hub/api/me/inbox*` the same way every other
 * hub route is. A `mailbox` event on `/hub/api/me/inbox/events` carries only
 * `{ id, op? }` — a nudge, never the row — so every event triggers a refetch
 * of the list rather than an attempt to apply the event in place.
 */

export type InboxItem = {
  uid: number;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
};

export type InboxState = {
  items: InboxItem[];
  unreadCount: number;
};

export type InboxEvent = {
  type: "mailbox";
  id: string;
  op?: "create" | "mark_read" | "mark_unread" | "trash" | "archive" | "restore";
};

type MailboxListResponse = {
  messages: Array<{
    uid: number;
    flags: string[];
    envelope: { from: string; subject?: string; date: string };
  }>;
};

const EMPTY_INBOX: InboxState = { items: [], unreadCount: 0 };

async function fetchInbox(): Promise<InboxState> {
  const response = await fetch("/hub/api/me/inbox", { credentials: "same-origin" });
  if (!response.ok) return EMPTY_INBOX;
  const body = (await response.json()) as MailboxListResponse;
  const items = body.messages.map((message) => ({
    uid: message.uid,
    subject: message.envelope.subject ?? "(no subject)",
    from: message.envelope.from,
    date: message.envelope.date,
    unread: !message.flags.includes("\\Seen"),
  }));
  return { items, unreadCount: items.filter((item) => item.unread).length };
}

/**
 * Subscribes to the inbox: fetches the current list once, then again on
 * every `mailbox` event. Returns an unsubscribe function.
 *
 * `onEvent`, when given, fires with the raw event ahead of the refetch it
 * triggers — for a caller (the desktop notification bridge, if one exists)
 * that only cares about `create` and does not want to wait on the list.
 */
export function subscribeInbox(
  onChange: (state: InboxState) => void,
  onEvent?: (event: InboxEvent) => void,
): () => void {
  let closed = false;

  const refresh = () => {
    void fetchInbox().then((state) => {
      if (!closed) onChange(state);
    });
  };

  refresh();

  const source = new EventSource("/hub/api/me/inbox/events", { withCredentials: true });
  source.addEventListener("mailbox", (event) => {
    if (closed) return;
    try {
      onEvent?.(JSON.parse((event as MessageEvent).data) as InboxEvent);
    } catch {
      // Malformed event body — the refetch below still keeps the list correct.
    }
    refresh();
  });

  return () => {
    closed = true;
    source.close();
  };
}
