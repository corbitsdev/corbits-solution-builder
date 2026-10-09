import { ApiFailure } from "../../client.js";

/**
 * A display-ready message for whatever a rejected promise threw. The hub's
 * own wording (`ApiFailure.detail.message`) is shown verbatim, since it is
 * already written for a person; anything else is framed the way an unreadable
 * version is — what happened, that nothing was lost, and to try again.
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof ApiFailure) return cause.detail.message;
  const detail = cause instanceof Error ? cause.message.trim() : typeof cause === "string" ? cause.trim() : "";
  if (detail.length > 0) return `Something could not be completed: ${detail} Nothing was lost — try again.`;
  return "Something could not be completed, and no detail was recorded. Nothing was lost — try again.";
}

/**
 * The bare reason, for a line that already says what failed and offers the
 * way out: the hub's own message, an error's message, or the value as text.
 */
export function failureReason(cause: unknown): string {
  if (cause instanceof ApiFailure) return cause.detail.message;
  if (cause instanceof Error) return cause.message.trim() || cause.name;
  const text = String(cause).trim();
  return text.length > 0 ? text : "no detail was recorded";
}
