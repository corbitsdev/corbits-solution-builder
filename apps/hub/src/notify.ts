/**
 * Desktop notification for an open decision.
 *
 * The run parked at its gate is the record; this is the ping. A notification
 * that fails is a missed ping and never a lost decision, so the failure is
 * remembered for the status line and then dropped, never retried into a
 * duplicate request.
 */
import { announcementFor, openDecisionFor, recordAnnouncement } from "./decisions.js";

function escapeForOsa(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function notifyDecision(projectId: string, runId: string): Promise<void> {
  const decision = await openDecisionFor(projectId);
  // The gate has moved on since the effect was queued: nothing to announce.
  if (!decision || decision.runId !== runId) return;
  if (announcementFor(decision.id)) return;

  const title = "Solutions Builder";
  const body = `${decision.title}. ${decision.consequence}`;

  let error: string | null = null;
  if (process.platform === "darwin") {
    const script = `display notification "${escapeForOsa(body)}" with title "${escapeForOsa(title)}"`;
    const result = Bun.spawnSync(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) error = result.stderr.toString().trim().slice(0, 500);
  } else {
    error = `No notification transport on ${process.platform}; the decision is still waiting in the app.`;
  }

  recordAnnouncement(decision.id, { at: error ? null : new Date(), error });
}
