/**
 * One companion specialist's ask-and-reply state: the requirements author,
 * the requirements explainer, or a panel principal, each its own deployment,
 * address and thread. Never an artifact, never a decision.
 */
export type CompanionState = {
  status: "idle" | "starting" | "waiting" | "done" | "error";
  address: string | null;
  reply: string | null;
  error: string | null;
  requestedAt: number;
  /** The reply is the project's recorded document already, not a fresh one to record. */
  recorded?: boolean;
};

export const IDLE_COMPANION: CompanionState = { status: "idle", address: null, reply: null, error: null, requestedAt: 0 };
