/**
 * A send refused because the specialist's run has ended (#413): the hub
 * answers 409 `workflow_run_terminal` once a sidecar has died or been
 * replaced, and the remembered address is a dead letter until the status
 * poll notices. Recognised by the hub's code, or by its sentence when the
 * code did not survive the mapping.
 */
export function isTerminalRunRefusal(cause: unknown): boolean {
  const code = typeof cause === "object" && cause !== null ? (cause as { detail?: { code?: unknown }; code?: unknown }) : null;
  const codes = [code?.detail?.code, code?.code].filter((value): value is string => typeof value === "string");
  if (codes.includes("workflow_run_terminal")) return true;
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return /is terminal and cannot receive more mail/i.test(message);
}

export const TERMINAL_RUN_NOTICE =
  "The specialist had stopped, so your message was not delivered. A fresh one is starting with the conversation so far; your message is back in the box, send it again once the specialist is ready.";
