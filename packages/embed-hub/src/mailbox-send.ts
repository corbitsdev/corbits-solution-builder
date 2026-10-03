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

/**
 * What a run is delivered for a frame the mailbox built: its subject as a
 * one-line header block, then its body. The trigger route takes content
 * only and leaves the delivered mail's subject unset
 * (`vendor/interchange/packages/hub-api/src/workflow-run-trigger.ts`), so a
 * tag the app puts in a subject, such as `[artifact:<id>:<version>]`,
 * reaches the specialist only this way. The frame is flat and its header
 * lines unfolded (`buildMailFrame`), so the header section is read line by line.
 */
function deliveredContent(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) return "";
  const subject = text
    .slice(0, split)
    .split("\r\n")
    .find((line) => line.toLowerCase().startsWith("subject:"))
    ?.slice("subject:".length)
    .trim();
  return `Subject: ${subject ?? ""}\n\n${text.slice(split + 4).trimEnd()}`;
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

/** The flag a Sent copy carries once the hub has accepted it as a trigger:
 *  the Message-ID the hub minted for the mail it delivered to the run, which
 *  is what the run's reply names in `In-Reply-To`. A client pairs a reply
 *  with the request it answers by it instead of by order (#62). */
export const TRIGGER_FLAG_PREFIX = "sb-trigger:";

/**
 * Records the hub's trigger Message-ID on the Sent copy, found by its own
 * Message-ID. Best-effort: a copy that cannot be found or flagged leaves the
 * send accepted and that turn's pairing to fall back on order.
 */
export async function recordTriggerId(
  db: MailboxDb,
  scope: { tenantId: string; principalId: string },
  messageId: string,
  triggerMessageId: string,
): Promise<boolean> {
  const sent = await openNativeMailboxStore(db, { ...scope, folder: "Sent" });
  const copy = sent.messages.find((message) => message.envelope.messageId === messageId);
  if (copy === undefined) return false;
  sent.addFlags(copy.uid, [`${TRIGGER_FLAG_PREFIX}${triggerMessageId}`]);
  await sent.settled;
  return true;
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
      const content = deliveredContent(message.raw);
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
        // The hub mints its own Message-ID for the mail it delivers to the
        // run, and the run's reply names that one, not the mailbox's (#62).
        const accepted = (await response.json().catch(() => null)) as { messageId?: unknown } | null;
        const scope = mailboxScope(c);
        if (scope && typeof accepted?.messageId === "string" && accepted.messageId.length > 0) {
          await recordTriggerId(opts.db, scope, message.messageId, accepted.messageId).catch((cause: unknown) => {
            console.error(`mailbox send: could not record the trigger id on ${message.messageId}: ${cause instanceof Error ? cause.message : String(cause)}`);
          });
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
