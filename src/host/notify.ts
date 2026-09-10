/**
 * Desktop notification for a durable human wait.
 *
 * The wait is already committed before this runs. A notification that fails is
 * a missed ping and never a lost decision — which is why the failure is
 * recorded on the wait row and then dropped, rather than retried into a
 * duplicate request.
 */
import { eq } from "drizzle-orm";
import { database } from "./db/client.js";
import * as table from "./db/schema.js";

function escapeForOsa(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function notifyWait(waitId: string): Promise<void> {
  const { db } = database();
  const [wait] = await db.select().from(table.humanWait).where(eq(table.humanWait.id, waitId));
  if (!wait) return;

  const title = "Solutions Builder";
  const body = `${wait.title}. ${wait.consequence}`;

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

  await db
    .update(table.humanWait)
    .set({ notifiedAt: error ? null : new Date(), notifyError: error })
    .where(eq(table.humanWait.id, waitId));
}
