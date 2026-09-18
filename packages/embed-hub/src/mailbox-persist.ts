/**
 * Ported from corbitsdev/workbench apps/hub/src/mailbox-persist.ts (as of
 * workbench head 29ad6ce): wires @corbits/mailbox's `createMailboxPersist`
 * onto the hub's own `persistMail` lookup so an agent's outbound mail also
 * lands a durable inbox row, not just the sidecar's own session record.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import type { AuthorizeMailboxSender } from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";

export function createHubMailboxAuthorizeSender(db: DB["db"]): AuthorizeMailboxSender {
  return async (senderAddress: string) => {
    const sender = await resolveRoutableAddress(db, senderAddress);
    if (sender === undefined) return null;
    const [row] = (await db.execute(
      sql`SELECT "domain" FROM "public"."tenant" WHERE "id" = ${sender.tenantId} LIMIT 1`,
    )) as unknown as { domain: string }[];
    if (row === undefined) return null;
    return { tenantId: sender.tenantId, domain: row.domain };
  };
}
