/**
 * A run's `trigger.payload` is not always the flat `{ projectId,
 * problemStatement }` object the client composed. `POST .../trigger` fires
 * through a signed conversation message, so the workflow-host's step
 * invoker (`vendor/interchange/packages/workflow-host/src/adapters/
 * step-invoker.ts`) hands agent steps the decoded `Mail` and joins its
 * text/plain parts into the turn body for them — but code that reads
 * `trigger.payload` directly, off the run's own `RunStarted` event, sees
 * the mail envelope verbatim: `{ headers, rawHeaders, parts: [{
 * contentType, ref, text }] }`, where `text` is the JSON string
 * `client.ts`'s `createProject` sent as `content`.
 *
 * This is the one place that unwraps either shape. Anything reading the
 * run's opening problem statement outside an agent step's own input
 * selector goes through it rather than assuming the flat shape.
 */

interface MailPart {
  readonly contentType?: unknown;
  readonly text?: unknown;
}

interface MailEnvelope {
  readonly parts?: unknown;
}

export interface Opening {
  readonly projectId: string;
  readonly problemStatement: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON text `client.ts` signs into the trigger's message body. */
function bodyTextOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const envelope = payload as MailEnvelope;
  if (!Array.isArray(envelope.parts)) return null;
  for (const part of envelope.parts) {
    if (!isRecord(part)) continue;
    const { contentType, text } = part as MailPart;
    if (contentType === "text/plain" && typeof text === "string") return text;
  }
  return null;
}

function fromFlat(payload: unknown): Opening | null {
  if (!isRecord(payload)) return null;
  const { projectId, problemStatement } = payload;
  if (typeof projectId !== "string" || typeof problemStatement !== "string") return null;
  const trimmed = problemStatement.trim();
  if (trimmed.length === 0) return null;
  return { projectId, problemStatement: trimmed };
}

/**
 * The run's opening `{ projectId, problemStatement }`, from a run's raw
 * `trigger.payload` in either shape it may arrive in: a mail envelope
 * (the trigger fired as a signed conversation message) whose text/plain
 * part carries the JSON `client.ts` composed, or that flat object
 * directly. `null` when neither shape yields a non-empty problem
 * statement.
 */
export function openingFromTrigger(payload: unknown): Opening | null {
  const flat = fromFlat(payload);
  if (flat) return flat;
  const bodyText = bodyTextOf(payload);
  if (bodyText === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return fromFlat(decoded);
}
