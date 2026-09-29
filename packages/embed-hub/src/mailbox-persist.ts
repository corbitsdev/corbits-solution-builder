/**
 * Ported from corbitsdev/workbench apps/hub/src/mailbox-persist.ts (as of
 * workbench head 29ad6ce): wires @corbits/mailbox's `createMailboxPersist`
 * onto the hub's own `persistMail` lookup so an agent's outbound mail lands a
 * durable row in every recipient's inbox.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import { resolveMailboxRecipients, type AuthorizeMailboxSender, type MailboxPersistArgs } from "@corbits/mailbox";
import { resolveRoutableAddress, type SidecarMailPersistedRow } from "@intx/hub-sessions";

/**
 * The vendored `persistMail` (hub-session-lookups.ts) keeps its own record of
 * a run's mail keyed on the run's `agent_session`, which Interchange never
 * creates for a workflow run, so it throws `Endpoint … has no session for
 * address …` for every run's reply. `@corbits/mailbox`'s `createMailboxPersist`
 * re-throws whatever its upstream throws even after its own durable write
 * succeeds, so skip the vendored write instead of letting it throw;
 * `@corbits/mailbox`'s own write already persisted this frame.
 *
 * The same holds for a sender that is not a run at all: a person's address
 * (`<ref_id>@domain`) never resolves through `resolveRoutableAddress`, which
 * only reads `workflow_run`, so the vendored write always throws
 * `No active endpoint found for sender address` for it.
 */
export function createHubPersistMailSkippingSessionless(
  db: DB["db"],
  upstream: (args: MailboxPersistArgs) => Promise<SidecarMailPersistedRow[]>,
): (args: MailboxPersistArgs) => Promise<SidecarMailPersistedRow[]> {
  return async (args) => {
    const sender = await resolveRoutableAddress(db, args.senderAddress);
    if (sender === undefined || sender.sessionId === null) {
      return [];
    }
    return upstream(args);
  };
}

/**
 * A person addressing another principal in their own tenant (decision
 * notifications, any other person-to-person mail) is not a `workflow_run`
 * and never resolves through `resolveRoutableAddress`. `senderAddressFor` in
 * index.ts mints that address from the principal's raw `ref_id`, which is
 * not lower-cased the way an agent's own address of the same person is
 * (`usr_<refId>@domain` vs. bare, and case can differ), so this is matched
 * the same case-insensitive way `persist.ts` already matches recipients:
 * `resolveMailboxRecipients` strips the `usr_` prefix / legacy bare form and
 * lower-cases the local part, then the row lookup accepts either the raw
 * `id` or a case-insensitive `ref_id` match.
 */
async function authorizeTenantPrincipalSender(
  db: DB["db"],
  senderAddress: string,
): Promise<{ tenantId: string; domain: string } | null> {
  const at = senderAddress.lastIndexOf("@");
  if (at < 0) return null;
  const domain = senderAddress.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0) return null;

  const [tenantRow] = (await db.execute(
    sql`SELECT "id" FROM "public"."tenant" WHERE lower("domain") = ${domain} LIMIT 1`,
  )) as unknown as { id: string }[];
  if (tenantRow === undefined) return null;

  const [resolved] = resolveMailboxRecipients([senderAddress], domain);
  if (resolved === undefined) return null;

  const [principalRow] = (await db.execute(
    sql`SELECT "id" FROM "public"."principal"
        WHERE "tenant_id" = ${tenantRow.id}
          AND ("id" = ${resolved.principalId} OR lower("ref_id") = ${resolved.principalId})
        LIMIT 1`,
  )) as unknown as { id: string }[];
  if (principalRow === undefined) return null;

  return { tenantId: tenantRow.id, domain };
}

export function createHubMailboxAuthorizeSender(db: DB["db"]): AuthorizeMailboxSender {
  return async (senderAddress: string) => {
    const sender = await resolveRoutableAddress(db, senderAddress);
    if (sender !== undefined) {
      const [row] = (await db.execute(
        sql`SELECT "domain" FROM "public"."tenant" WHERE "id" = ${sender.tenantId} LIMIT 1`,
      )) as unknown as { domain: string }[];
      if (row === undefined) return null;
      return { tenantId: sender.tenantId, domain: row.domain };
    }
    return authorizeTenantPrincipalSender(db, senderAddress);
  };
}
