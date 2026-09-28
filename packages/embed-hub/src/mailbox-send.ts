/**
 * Ported from corbitsdev/workbench apps/hub/src/mailbox-send.ts (as of
 * workbench head 29ad6ce): a person's mailbox send to an agent is a
 * deployment trigger, not a mailbox write. A run address is not a mailbox,
 * so the frame cannot ride the mail persist path; it is handed to the hub's
 * own `POST /api/tenants/:tenantId/workflows/:runId/mail`, the route that
 * signs, authorizes and dispatches a person's message to a run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import { parseRunAddress } from "@intx/types";
import {
  moveNativeMailboxMessage,
  openNativeMailboxStore,
  type MailboxDb,
  type MailboxEventBus,
  type OutgoingMailboxMessage,
} from "@corbits/mailbox";

/** The send route's own request, so `deliver` can replay the caller's
 * session against the run-trigger route it has no context for. */
const mailboxRequest = new AsyncLocalStorage<Context>();

export function captureMailboxRequest(): MiddlewareHandler {
  return (c, next) => mailboxRequest.run(c as Context, next);
}

/** The text of a frame this package built: flat, so everything after the
 * header section is the body. */
function frameBody(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  const split = text.indexOf("\r\n\r\n");
  return split < 0 ? "" : text.slice(split + 4).trimEnd();
}

export type MailboxDeliverOpts = {
  /** The hub app itself — the trigger runs through its real route stack,
   * middleware and grants included. */
  readonly app: { request(input: string, init?: RequestInit): Response | Promise<Response> };
  readonly persistMail: (args: {
    senderAddress: string;
    recipients: string[];
    raw: Uint8Array;
  }) => Promise<unknown>;
  /** The mailbox the send route wrote the Sent copy to, so a refused
   * trigger can take that copy back (#61). */
  readonly db: MailboxDb;
  /** Told when the Sent copy moves, so an open client re-reads. */
  readonly bus?: MailboxEventBus;
};

/**
 * The mailbox owner the send route resolved: the run-mailbox mount reads
 * the tenant and principal its middleware put on the request, and this
 * reads the same two, so the Sent copy is looked for where it was written.
 */
function mailboxScope(c: Context): { tenantId: string; principalId: string } | null {
  const get = (c as unknown as { get(key: string): { id: string } | undefined }).get.bind(c);
  const tenant = get("tenant");
  const principal = get("principal");
  if (!tenant?.id || !principal?.id) return null;
  return { tenantId: tenant.id, principalId: principal.id };
}

/**
 * Takes back the Sent copy of a message the hub did not accept (#61). The
 * mailbox appends to Sent before it hands the message over, so a refused
 * trigger left the message looking sent: every reply pairing by order then
 * ran one behind, and the brief evaluator found the undelivered request on
 * its next mount, never re-sent it, and waited on it for good. The copy
 * goes to Trash, found by its Message-ID, before the failure is rethrown.
 * Best-effort: a failure here must not hide the delivery failure itself.
 */
export async function withdrawSentCopy(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
  messageId: string,
  bus?: MailboxEventBus,
): Promise<boolean> {
  const sent = await openNativeMailboxStore(db, { ...scope, folder: "Sent" });
  const copy = sent.messages.find((message) => message.envelope.messageId === messageId);
  if (copy === undefined) return false;
  const uid = await moveNativeMailboxMessage(db, scope, "Sent", copy.uid, "Trash");
  try {
    bus?.publish(scope, { type: "mailbox", id: `Sent:${String(copy.uid)}`, op: "trash" });
    bus?.publish(scope, { type: "mailbox", id: `Trash:${String(uid)}`, op: "create" });
  } catch {
    // The move is durable; a listener that missed the event re-reads on its own.
  }
  return true;
}

export function createMailboxDeliver(
  opts: MailboxDeliverOpts,
): (message: OutgoingMailboxMessage) => Promise<void> {
  return async (message) => {
    const runs = message.to.flatMap((address) => {
      const parsed = parseRunAddress(address);
      return parsed === null ? [] : [parsed.runId];
    });
    const others = message.to.filter((address) => parseRunAddress(address) === null);

    if (runs.length > 0) {
      const c = mailboxRequest.getStore();
      if (c === undefined) {
        throw new Error("mailbox deliver ran outside a mailbox request");
      }
      const tenantId = c.req.param("tenantId") ?? "";
      const headers = new Headers({ "content-type": "application/json" });
      for (const name of ["cookie", "authorization"]) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      const content = frameBody(message.raw);
      for (const runId of runs) {
        const path = `/api/tenants/${encodeURIComponent(tenantId)}/workflows/${encodeURIComponent(runId)}/mail`;
        const response = await opts.app.request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({ content }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const scope = mailboxScope(c);
          if (scope) {
            await withdrawSentCopy(opts.db, scope, message.messageId, opts.bus).catch((cause: unknown) => {
              console.error(`mailbox send: could not withdraw the Sent copy of ${message.messageId}: ${cause instanceof Error ? cause.message : String(cause)}`);
            });
          }
          throw new Error(`trigger for ${runId} answered ${String(response.status)}: ${detail}`);
        }
      }
    }

    if (others.length > 0) {
      await opts.persistMail({
        senderAddress: message.from,
        recipients: others,
        raw: message.raw,
      });
    }
  };
}
