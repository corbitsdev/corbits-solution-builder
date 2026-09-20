import { ApiFailure } from "../../client.js";

/**
 * A display-ready message for whatever a rejected promise threw. The hub's
 * own wording (`ApiFailure.detail.message`) is shown verbatim, since it is
 * already written for a person; anything else falls back to what the
 * platform gives us.
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof ApiFailure) return cause.detail.message;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}
