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
  readonly inReplyTo?: string;
};

type Envelope = {
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
};

type InboxMessage = { readonly uid: number; readonly envelope: Envelope; readonly raw: string };
type InboxPage = { readonly messages: readonly InboxMessage[] };

function mailboxPath(tenantId: string): string {
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

async function readFolder(
  transport: Transport,
  tenantId: string,
  folder: "INBOX" | "Sent",
  agentAddresses: ReadonlySet<string>,
): Promise<ChatMessage[]> {
  const page = await transport.fetch<InboxPage>(
    "GET",
    `${mailboxPath(tenantId)}?folder=${folder}&limit=100`,
  );
  return page.messages.flatMap((message) => {
    const address = participantAddress(message.envelope, message.raw, agentAddresses);
    if (address === undefined) return [];
    return [
      {
        id: `${folder}:${String(message.uid)}`,
        author: folder === "Sent" ? ("me" as const) : ("agent" as const),
        body: frameBody(message.raw),
        at: message.envelope.date,
        ...(message.envelope.inReplyTo !== undefined
          ? { inReplyTo: message.envelope.inReplyTo }
          : {}),
      },
    ];
  });
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

/** Sends (or replies in) a stage conversation: the same send seam a
 * workbench chat uses, scoped to the stage agent's current address. */
export async function sendStageMail(
  tenantId: string,
  agentAddress: string,
  input: { readonly body: string; readonly subject?: string; readonly inReplyTo?: string },
): Promise<void> {
  const transport = createHubTransport();
  await transport.fetch("POST", `${mailboxPath(tenantId)}/send`, {
    to: [agentAddress],
    subject: input.subject ?? input.body.slice(0, 60),
    body: input.body,
    ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
  });
}
