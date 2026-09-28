/**
 * Nudges from `@corbits/mailbox`'s tenant-scoped stream
 * (`/api/tenants/:tenantId/mailbox/me/inbox/events`), so a caller can refetch
 * a thread the moment a specialist replies rather than waiting on a poll.
 *
 * Same shape as the legacy un-scoped stream in `inbox.ts`: a `mailbox` event
 * carries only `{ id, op }`, never the row, so every relevant event just
 * triggers a refetch. The id is scoped on this stream, though -- see
 * `shouldRefetch`. Unlike `inbox.ts`, the caller decides what "relevant"
 * means (`shouldRefetch`) and drives its own reconnect backoff.
 */
import { hubEventSourceCredentials, hubOrigin } from "./hub-origin.ts";
import { openSharedEventSource } from "./shared-event-source.ts";

export type MailboxEvent = {
  id: string;
  op?: "create" | "mark_read" | "mark_unread" | "archive" | "trash" | "restore";
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * True for a `create` op landing in INBOX — the only kind worth a refetch
 * here. The folder is the id's second-to-last segment: the un-scoped stream
 * names a row `<folder>:<uid>`, while the tenant-scoped stream this file
 * subscribes to names it `<tenant>:<principal>:<folder>:<uid>`
 * (`@corbits/mailbox`'s `write.ts` and `persist.ts`). Reading only a leading
 * `INBOX:` dropped every push the tenant stream carried (#159): a
 * specialist's reply was persisted, published and delivered to the tab, and
 * then discarded here, so the thread waited on the fallback poll instead.
 */
export function shouldRefetch(event: MailboxEvent): boolean {
  if (event.op !== "create") return false;
  const parts = event.id.split(":");
  return parts.length >= 2 && parts[parts.length - 2] === "INBOX";
}

/** Capped exponential backoff: 1s, 2s, 4s, ... up to 30s. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/** The stream is id-only and drops events past a 100-deep queue, so an open
 * stream can still miss a nudge — the fallback poll must fire regardless of
 * `open` once this long has passed since the last successful load. */
export const FALLBACK_REFETCH_MS = 60_000;

export function shouldFallbackRefetch({
  open,
  msSinceLastLoad,
}: {
  open: boolean;
  msSinceLastLoad: number;
}): boolean {
  return !open || msSinceLastLoad >= FALLBACK_REFETCH_MS;
}

export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};

export type SubscribeMailboxDeps = {
  createEventSource: (url: string, withCredentials: boolean) => EventSourceLike;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
};

const defaultDeps: SubscribeMailboxDeps = {
  createEventSource: (url, withCredentials) => openSharedEventSource(url, withCredentials),
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

export type MailboxSubscription = {
  unsubscribe: () => void;
  isOpen: () => boolean;
};

/**
 * Opens the tenant-scoped mailbox stream and calls `onNudge` for every
 * `create` event in INBOX. Reconnects with capped exponential backoff on
 * error, and closes for good once `unsubscribe` is called.
 */
export function subscribeMailbox(
  tenantId: string,
  onNudge: (event: MailboxEvent) => void,
  deps: SubscribeMailboxDeps = defaultDeps,
): MailboxSubscription {
  let closed = false;
  let open = false;
  let attempt = 0;
  let everOpened = false;
  let source: EventSourceLike | null = null;
  let retryHandle: number | null = null;

  const connect = () => {
    if (closed) return;
    const url = `${hubOrigin()}/api/tenants/${tenantId}/mailbox/me/inbox/events`;
    const es = deps.createEventSource(url, hubEventSourceCredentials());
    source = es;
    es.addEventListener("open", () => {
      if (closed) return;
      open = true;
      attempt = 0;
      // A stream that opens again (the shared source reconnecting after the
      // tab was hidden, #91) may have missed nudges meanwhile: one synthetic
      // INBOX create makes the caller refetch, the same as a real one.
      if (everOpened) onNudge({ id: "INBOX:reconnected", op: "create" });
      everOpened = true;
    });
    es.addEventListener("mailbox", (event) => {
      if (closed) return;
      let parsed: MailboxEvent;
      try {
        parsed = JSON.parse(event.data) as MailboxEvent;
      } catch {
        return;
      }
      if (shouldRefetch(parsed)) onNudge(parsed);
    });
    es.addEventListener("error", () => {
      if (closed) return;
      open = false;
      es.close();
      const delay = nextBackoffMs(attempt);
      attempt += 1;
      retryHandle = deps.setTimeout(connect, delay);
    });
  };

  connect();

  return {
    unsubscribe: () => {
      closed = true;
      open = false;
      if (retryHandle !== null) deps.clearTimeout(retryHandle);
      source?.close();
    },
    isOpen: () => open,
  };
}
