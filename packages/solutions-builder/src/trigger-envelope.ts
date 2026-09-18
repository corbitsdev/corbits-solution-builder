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

/**
 * A round's own mail: `{ stage, command, message, audiences, documents,
 * feedback, inference }`, the JSON text a client sends with every stage
 * input (BUILD_PLAN_V3, the "chat section" contract). `stage` defaults to
 * `1` and `command` to `"stage.draft"` when the decoded body carries no
 * `command` at all — which is exactly the shape of the opening mail from
 * project creation, so that mail is treated as `{ stage: 1, command:
 * "stage.draft", message: <opening text> }` rather than as a round this
 * module does not recognize.
 */
export interface RoundEnvelope {
  readonly stage: number;
  readonly command: string;
  readonly message?: string;
  readonly audiences?: readonly string[];
  readonly documents?: readonly string[];
  readonly feedback?: string;
  readonly inference?: Record<string, unknown>;
}

function isStage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function fromRoundBody(payload: unknown): RoundEnvelope | null {
  if (!isRecord(payload)) return null;
  const { command, stage, message, audiences, documents, feedback, inference } = payload;
  if (typeof command !== "string") return null;
  const audienceList = asStringArray(audiences);
  const documentList = asStringArray(documents);
  return {
    stage: isStage(stage) ? stage : 1,
    command,
    ...(typeof message === "string" ? { message } : {}),
    ...(audienceList ? { audiences: audienceList } : {}),
    ...(documentList ? { documents: documentList } : {}),
    ...(typeof feedback === "string" ? { feedback } : {}),
    ...(isRecord(inference) ? { inference } : {}),
  };
}

/**
 * A round's mail, from a run's raw `trigger.payload` in either shape it may
 * arrive in — see `openingFromTrigger`. Defaults to `{ stage: 1, command:
 * "stage.draft" }` when the payload names no `command` and carries no
 * opening problem statement either.
 */
export function roundFromTrigger(payload: unknown): RoundEnvelope {
  const bodyText = bodyTextOf(payload);
  if (bodyText !== null) {
    try {
      const round = fromRoundBody(JSON.parse(bodyText));
      if (round) return round;
    } catch {
      // Not JSON, or not a round shape: fall through to the opening shape.
    }
  } else {
    const round = fromRoundBody(payload);
    if (round) return round;
  }
  const opening = openingFromTrigger(payload);
  if (opening) return { stage: 1, command: "stage.draft", message: opening.problemStatement };
  return { stage: 1, command: "stage.draft" };
}
