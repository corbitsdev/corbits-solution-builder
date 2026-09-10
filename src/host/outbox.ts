/**
 * Outbox drain.
 *
 * Entries are committed with the state change they describe, so this loop only
 * ever delivers effects that already happened. Delivery is at-least-once and
 * every consumer here is idempotent; an entry that keeps failing is
 * quarantined rather than retried forever.
 */
import { asc, isNull, and, eq, lt } from "drizzle-orm";
import { database } from "./db/client.js";
import * as table from "./db/schema.js";
import { notifyWait } from "./notify.js";

const MAX_ATTEMPTS = 5;

async function deliver(entry: typeof table.outboxEntry.$inferSelect): Promise<void> {
  if (entry.topic === "human_wait.opened") {
    const payload = entry.payload as { waitId?: string };
    if (payload.waitId) await notifyWait(payload.waitId);
  }
  // Other topics are read models with no external effect yet; recording the
  // delivery is the whole job.
}

export async function drainOutbox(): Promise<{ delivered: number; quarantined: number }> {
  const { db } = database();
  const pending = await db
    .select()
    .from(table.outboxEntry)
    .where(
      and(
        isNull(table.outboxEntry.deliveredAt),
        isNull(table.outboxEntry.quarantinedAt),
        lt(table.outboxEntry.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(asc(table.outboxEntry.createdAt))
    .limit(50);

  let delivered = 0;
  let quarantined = 0;
  for (const entry of pending) {
    try {
      await deliver(entry);
      await db
        .update(table.outboxEntry)
        .set({ deliveredAt: new Date() })
        .where(eq(table.outboxEntry.id, entry.id));
      delivered += 1;
    } catch (cause) {
      const attempts = entry.attempts + 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      const exhausted = attempts >= MAX_ATTEMPTS;
      if (exhausted) quarantined += 1;
      await db
        .update(table.outboxEntry)
        .set({
          attempts,
          lastError: message.slice(0, 500),
          quarantinedAt: exhausted ? new Date() : null,
        })
        .where(eq(table.outboxEntry.id, entry.id));
    }
  }
  return { delivered, quarantined };
}
