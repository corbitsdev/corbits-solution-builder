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

/**
 * How a person's mail names a picture that is to ride with it (#915). The
 * mailbox send route carries text only, so the client writes
 * `[attach:<artifact id>]` into the body for each attached image, and this
 * bridge turns each into a real attachment on the run trigger. The web
 * client's `imageMarker` (`approved-chain.ts`) writes the same form.
 */
export const ATTACH_MARKER = /\s*\[attach:([^\]\s]+)\]/g;

/** Image types a model can be shown; what the material picker accepts. */
const ATTACHABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type TriggerAttachment = { mimeType: string; data: string; name: string };

/** The markers taken out of the text the run reads, and the artifacts they name, each once. */
export function takeAttachMarkers(content: string): { text: string; artifactIds: string[] } {
  const artifactIds: string[] = [];
  const text = content.replace(ATTACH_MARKER, (_whole, id: string) => {
    if (!artifactIds.includes(id)) artifactIds.push(id);
    return "";
  });
  return { text, artifactIds };
}

/** The filename a `Content-Disposition` header names, or null. */
function dispositionFilename(header: string | null): string | null {
  if (header === null) return null;
  const encoded = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      return null;
    }
  }
  const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? /filename=([^;]+)/.exec(header)?.[1];
  return quoted === undefined ? null : quoted.trim();
}

/**
 * One marked artifact's bytes, read the way the person's own browser reads
 * them: the artifacts download route, under the caller's own session, so a
 * picture another tenant owns is a 404 here as it is there. Anything that is
 * not an image a model can be shown is refused, never silently left out: a
 * mail that says a picture is attached must carry it.
 */
async function readImageAttachment(
  app: MailboxDeliverOpts["app"],
  tenantId: string,
  headers: Headers,
  artifactId: string,
): Promise<TriggerAttachment> {
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
  const response = await app.request(path, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`the picture ${artifactId} could not be read to attach it (${String(response.status)})`);
  }
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ATTACHABLE_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`the attachment ${artifactId} is ${mimeType || "of unknown type"}, not a picture a specialist can be shown`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = (dispositionFilename(response.headers.get("content-disposition")) ?? artifactId).replace(/["\r\n]/g, "");
  return { mimeType, data: Buffer.from(bytes).toString("base64"), name };
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
      const session = new Headers();
      for (const name of ["cookie", "authorization"]) {
        const value = c.req.header(name);
        if (value !== undefined) session.set(name, value);
      }
      const headers = new Headers(session);
      headers.set("content-type", "application/json");
      // A send the run never receives must not leave its Sent copy looking
      // sent (#61), whether the trigger refused it or a picture it names
      // could not be attached.
      const withdraw = async () => {
        const scope = mailboxScope(c);
        if (!scope) return;
        await withdrawSentCopy(opts.db, scope, message.messageId, opts.bus).catch((cause: unknown) => {
          console.error(`mailbox send: could not withdraw the Sent copy of ${message.messageId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        });
      };
      const { text: content, artifactIds } = takeAttachMarkers(frameBody(message.raw));
      let attachments: TriggerAttachment[];
      try {
        attachments = await Promise.all(artifactIds.map((artifactId) => readImageAttachment(opts.app, tenantId, session, artifactId)));
      } catch (cause) {
        await withdraw();
        throw cause;
      }
      for (const runId of runs) {
        const path = `/api/tenants/${encodeURIComponent(tenantId)}/workflows/${encodeURIComponent(runId)}/mail`;
        const response = await opts.app.request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({ content, ...(attachments.length > 0 ? { attachments } : {}) }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          await withdraw();
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
