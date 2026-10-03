/**
 * A stage's conversation is a mail thread with its agent, exactly like a
 * workbench chat (see corbitsdev/workbench `apps/web/src/chat/threads-api.ts`
 * and `docs/chat-mail-threading.md`). No stage-specific hub route exists:
 * the person's own turns live in the mailbox's `Sent` folder, the agent's
 * replies land in `INBOX`, and a thread is every message whose `from`/`to`
 * intersects the agent's address(es).
 */
import { createHubTransport, type Transport } from "./hub.ts";

export type ChatMessage = {
  readonly id: string;
  readonly author: "me" | "agent";
  readonly body: string;
  readonly at: string;
  /** The mail's subject. An opening the app composes carries its
   *  `[opening:<project>:<stage>]` marker here (`use-opening-dispatch.ts`),
   *  which is how the transcript knows to fold the body. */
  readonly subject?: string;
  /** The mail's own RFC Message-ID. Absent on a turn imported from a
   *  legacy transcript, which was never mail. */
  readonly messageId?: string;
  /** An agent reply: the RFC Message-ID it answers. */
  readonly inReplyTo?: string;
  /** A person turn the hub accepted as a trigger: the Message-ID the hub
   *  minted for the mail it delivered, which the reply's `inReplyTo` names
   *  (#62). Absent for a turn sent before this was recorded, or refused. */
  readonly triggerMessageId?: string;
};

/** The flag the hub sets on a Sent copy it delivered as a trigger; see
 * `packages/embed-hub/src/mailbox-send.ts`. */
export const TRIGGER_FLAG_PREFIX = "sb-trigger:";

/** How many pages one folder read follows before giving up: a stage's
 * thread is a few dozen messages; a workspace's folder can hold thousands. */
const MAX_FOLDER_PAGES = 50;

type Envelope = {
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
};

type InboxMessage = {
  readonly uid: number;
  readonly flags?: readonly string[];
  readonly envelope: Envelope;
  readonly raw: string;
};
type InboxPage = { readonly messages: readonly InboxMessage[]; readonly nextCursor?: string };

export function mailboxPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/mailbox/me/inbox`;
}

/** Base64 to text as UTF-8. `atob` alone yields one char per byte, which
 * turns any non-ASCII body into mojibake. */
function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** First `text/plain` leaf of a MIME entity, descending nested multiparts
 * (an agent reply is `multipart/signed` around `multipart/mixed`). The
 * boundary is matched case-sensitively: it is a token, not a header name. */
function textPart(entity: string): string | undefined {
  const split = entity.indexOf("\n\n");
  if (split < 0) return undefined;
  const headers = entity.slice(0, split);
  const body = entity.slice(split + 2);
  const boundary = /boundary="?([^";\n]+)"?/i.exec(headers)?.[1];
  if (boundary === undefined) {
    return /content-type:\s*text\/plain/i.test(headers) || !/content-type:/i.test(headers)
      ? body.trim()
      : undefined;
  }
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const found = textPart(part.replace(/^\n/, ""));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Undoes a JSON string's escaping when it has leaked into a rendered body
 * without ever being through `JSON.parse` — a small local model asked for
 * multi-line markdown sometimes emits the literal two characters `\` `n`
 * instead of a newline, as if it were still inside a quoted string. Ordinary
 * prose has no reason to carry more than a couple of literal `\n` pairs, so
 * this only fires when they dominate over real newlines.
 */
export function unescapeLiteralNewlines(text: string): string {
  const real = (text.match(/\n/g) ?? []).length;
  const literal = (text.match(/\\n/g) ?? []).length;
  if (literal < 2 || real > literal / 4) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
}

/** The readable text of an RFC 5322 frame: the bytes after the header
 * section, or the first `text/plain` part of a multipart one. */
function frameBody(raw: string): string {
  let decoded: string;
  try {
    decoded = base64ToUtf8(raw);
  } catch {
    return "";
  }
  const body = textPart(decoded.replace(/\r\n/g, "\n")) ?? "";
  return unescapeLiteralNewlines(body);
}

function extractAddress(raw: string): string {
  return (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim();
}

/** Addresses on a frame's `To:` header, unfolded and parsed straight from
 * `raw` — the fallback for a person turn, whose `envelope.to` the mailbox
 * may report empty. */
function toHeaderAddresses(raw: string): string[] {
  let decoded: string;
  try {
    decoded = base64ToUtf8(raw);
  } catch {
    return [];
  }
  const headers = decoded.replace(/\r\n/g, "\n").split("\n\n")[0] ?? "";
  const unfolded = headers.replace(/\n[ \t]+/g, " ");
  const to = /^to:\s*(.+)$/im.exec(unfolded)?.[1];
  return to === undefined ? [] : to.split(",").map((address) => address.trim());
}

/** The stage agent address on a message, from whichever side (from/to)
 * carries one — matched case-insensitively against the given address set. */
function participantAddress(
  envelope: Pick<Envelope, "from" | "to">,
  raw: string,
  agentAddresses: ReadonlySet<string>,
): string | undefined {
  const to = envelope.to.length > 0 ? envelope.to : toHeaderAddresses(raw);
  return [envelope.from, ...to]
    .map(extractAddress)
    .find((address) => agentAddresses.has(address.toLowerCase()));
}

/** The trigger Message-ID a Sent copy's flags record, if the hub set one. */
function triggerIdOf(flags: readonly string[] | undefined): string | undefined {
  const flag = flags?.find((entry) => entry.startsWith(TRIGGER_FLAG_PREFIX));
  return flag === undefined ? undefined : flag.slice(TRIGGER_FLAG_PREFIX.length);
}

/**
 * Every message of a folder, following `nextCursor` to the end. One page of
 * the newest 100 was the whole read once (#62): on a busy workspace one
 * folder's window then cut off before the other's, and a reply whose request
 * had fallen out of the Sent window paired with the next request instead.
 */
async function readFolder(
  transport: Transport,
  tenantId: string,
  folder: "INBOX" | "Sent",
  agentAddresses: ReadonlySet<string>,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_FOLDER_PAGES; pages += 1) {
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const page = await transport.fetch<InboxPage>(
      "GET",
      `${mailboxPath(tenantId)}?folder=${folder}&limit=100${query}`,
    );
    for (const message of page.messages) {
      const address = participantAddress(message.envelope, message.raw, agentAddresses);
      if (address === undefined) continue;
      const triggerMessageId = folder === "Sent" ? triggerIdOf(message.flags) : undefined;
      messages.push({
        id: `${folder}:${String(message.uid)}`,
        author: folder === "Sent" ? ("me" as const) : ("agent" as const),
        body: frameBody(message.raw),
        at: message.envelope.date,
        messageId: message.envelope.messageId,
        ...(message.envelope.subject ? { subject: message.envelope.subject } : {}),
        ...(message.envelope.inReplyTo !== undefined
          ? { inReplyTo: message.envelope.inReplyTo }
          : {}),
        ...(triggerMessageId !== undefined ? { triggerMessageId } : {}),
      });
    }
    if (page.nextCursor === undefined || page.messages.length === 0) break;
    cursor = page.nextCursor;
  }
  return messages;
}

/** A stage's full transcript: every mail turn addressed to or from any of
 * the stage agent's addresses, oldest first. */
export async function readStageThread(
  tenantId: string,
  agentAddresses: readonly string[],
): Promise<ChatMessage[]> {
  const transport = createHubTransport();
  const addresses = new Set(agentAddresses.map((address) => address.toLowerCase()));
  const [inbox, sent] = await Promise.all([
    readFolder(transport, tenantId, "INBOX", addresses),
    readFolder(transport, tenantId, "Sent", addresses),
  ]);
  return [...inbox, ...sent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The Message-ID the specialist's run last saw on this thread: its latest
 * reply, or the latest turn it accepted as a trigger. That is the run's
 * connector `lastMessageId`, so a send naming it in `In-Reply-To` continues
 * the run's thread and its reply names that send's trigger id (#62).
 */
function threadTip(thread: readonly ChatMessage[]): string | undefined {
  for (const message of [...thread].reverse()) {
    const id = message.author === "agent" ? message.messageId : message.triggerMessageId;
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Sends (or replies in) a stage conversation: the same send seam a
 * workbench chat uses, scoped to the stage agent's current address and
 * threaded onto what that address last saw. */
export async function sendStageMail(
  tenantId: string,
  agentAddress: string,
  input: { readonly body: string; readonly subject?: string },
): Promise<void> {
  const inReplyTo = threadTip(await readStageThread(tenantId, [agentAddress]));
  await createHubTransport().fetch("POST", `${mailboxPath(tenantId)}/send`, {
    to: [agentAddress],
    subject: input.subject ?? input.body.slice(0, 60),
    body: input.body,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
  });
}
