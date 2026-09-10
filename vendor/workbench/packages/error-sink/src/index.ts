// The one entry point every catch block calls instead of swallowing a
// failure (CL-6496, the owner ruling this package exists to enforce).
//
// `@intx/log` (LogTape underneath) is already the repo's one logging
// concept -- 65+ `getLogger`/`log.error` call sites across apps/hub and a
// dozen packages -- and it already has a pluggable-sink seam and
// universal runtime support (Node, Bun, browsers). This package adds
// only what that seam is missing: a fixed structured-error convention
// (operation, optional tenant/room/agent identifiers, and a `refId` a
// person can quote to support -- the same pattern
// `packages/onboarding/src/routes.ts`'s `reportOnboardingError` already
// establishes) plus a redaction pass, so no call site hand-rolls that
// shape or leaks a secret into a log line. Reaching OTEL/Sentry later is
// a LogTape sink registered once via `@intx/log`'s `configureSync`/
// `setup` -- nothing here changes when that happens.
//
// The guarantee that makes this safe to sprinkle into any catch block:
// `reportError` itself never throws. A malformed context degrades to
// `operation: "unknown"` rather than rejecting the report outright, and
// a throwing sink is LogTape's own concern to isolate -- this function's
// own try/catch is the last line of defense either way.
import { getLogger } from "@intx/log";
import { type } from "arktype";
import {
  ErrorContext,
  type ErrorContext as ErrorContextInput,
} from "./context";
import { redactExtra, redactText } from "./redact";
import { generateRefId } from "./ref-id";

const UNKNOWN_OPERATION = "unknown";
// A cyclic or unbounded `.cause` chain must not make the logger recurse
// forever; this caps how many links get carried over.
const MAX_CAUSE_DEPTH = 5;

const log = getLogger(["errors"]);

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function redactedCopyOf(error: Error, depth = 0): Error {
  const redacted = new Error(redactText(error.message));
  if (error.stack !== undefined) redacted.stack = redactText(error.stack);
  if (depth < MAX_CAUSE_DEPTH && error.cause !== undefined) {
    redacted.cause = redactedCopyOf(asError(error.cause), depth + 1);
  }
  return redacted;
}

/**
 * Reports a caught failure through `@intx/log` and returns the `refId` to
 * show the person who hit it. Never throws, never blocks the caller's
 * control flow.
 */
export function reportError(
  error: unknown,
  context: ErrorContextInput,
): string {
  try {
    const refId = context.refId ?? generateRefId();
    const parsed = ErrorContext(context);
    const safeContext = parsed instanceof type.errors ? undefined : parsed;
    const operation = safeContext?.operation ?? UNKNOWN_OPERATION;

    const properties: Record<string, unknown> = { refId, operation };
    if (safeContext?.tenantId !== undefined) {
      properties.tenantId = safeContext.tenantId;
    }
    if (safeContext?.roomId !== undefined) {
      properties.roomId = safeContext.roomId;
    }
    if (safeContext?.agentId !== undefined) {
      properties.agentId = safeContext.agentId;
    }
    const redactedExtra = redactExtra(safeContext?.extra);
    if (redactedExtra !== undefined) {
      properties.extra = redactedExtra;
    }

    log.error(redactedCopyOf(asError(error)), properties);
    return refId;
  } catch {
    return context.refId ?? UNKNOWN_OPERATION;
  }
}

export type { ErrorContext } from "./context";
export { generateRefId } from "./ref-id";
export {
  ErrorEnvelopeShape,
  makeErrorEnvelope,
  parseErrorEnvelope,
} from "./error-envelope";
export type { ErrorEnvelope } from "./error-envelope";
