/**
 * Ported from corbitsdev/workbench apps/hub/src/mailbox-persist.ts (as of
 * workbench head 29ad6ce): wires @corbits/mailbox's `createMailboxPersist`
 * onto the hub's own `persistMail` lookup so an agent's outbound mail also
 * lands a durable inbox row, not just the sidecar's own session record.
 */
import { sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import type { AuthorizeMailboxSender, MailboxPersistArgs } from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";

/** The `create`/`has` slice of `EventCollectorRegistry` `ensureRunSession`
 * needs (see @intx/hub-sessions's `event-collector-registry.ts`). */
export type EventCollectorPort = {
  create(agentAddress: string, tenantId: string, sessionId: string, runId: string): void;
  has(agentAddress: string): boolean;
};

/**
 * True upsert of a run's `agent_session`, keyed by the run's own principal
 * once Interchange anchors one. Ported from workbench's
 * packages/workflows/src/launch/agent-session.ts `ensureRunSession` as raw
 * SQL (no `@corbits/workflows` dependency here, and this build's `@intx/db`
 * typecheck surface has no relational query builder for `workflow_run`,
 * `workflow_run_launch_spec`, or `agent_session` — every other lookup in
 * this package goes through `db.execute(sql\`...\`)` for the same reason).
 */
async function ensureRunSession(params: {
  readonly db: DB["db"];
  readonly eventCollectors: EventCollectorPort;
  readonly runId: string;
}): Promise<string | null> {
  const { db, eventCollectors, runId } = params;
  const [runRow] = (await db.execute(
    sql`SELECT "id", "tenant_id" AS "tenantId", "definition_id" AS "definitionId", "principal_id" AS "principalId", "address"
        FROM "public"."workflow_run" WHERE "id" = ${runId} LIMIT 1`,
  )) as unknown as {
    id: string;
    tenantId: string;
    definitionId: string;
    principalId: string | null;
    address: string | null;
  }[];
  if (runRow === undefined) return null;

  const [launchSpecRow] = (await db.execute(
    sql`SELECT "session_id" AS "sessionId" FROM "public"."workflow_run_launch_spec" WHERE "anchor_run_id" = ${runId} LIMIT 1`,
  )) as unknown as { sessionId: string }[];
  if (launchSpecRow === undefined) {
    throw new Error(
      `ensureRunSession: no workflow_run_launch_spec for run "${runId}" — every launcher records one at provision time`,
    );
  }
  const sessionId = launchSpecRow.sessionId;

  if (runRow.principalId !== null) {
    const [sessionRow] = (await db.execute(
      sql`SELECT "principal_id" AS "principalId" FROM "public"."agent_session" WHERE "id" = ${sessionId} LIMIT 1`,
    )) as unknown as { principalId: string }[];
    const now = new Date();
    if (sessionRow === undefined) {
      await db.execute(
        sql`INSERT INTO "public"."agent_session"
              ("id", "tenant_id", "agent_id", "principal_id", "status", "created_at", "updated_at")
            VALUES (${sessionId}, ${runRow.tenantId}, ${runRow.definitionId}, ${runRow.principalId}, 'active', ${now}, ${now})
            ON CONFLICT ("id") DO NOTHING`,
      );
    } else if (sessionRow.principalId !== runRow.principalId) {
      await db.execute(
        sql`UPDATE "public"."agent_session" SET "principal_id" = ${runRow.principalId}, "updated_at" = ${now} WHERE "id" = ${sessionId}`,
      );
    }
  }

  if (runRow.address !== null && !eventCollectors.has(runRow.address)) {
    eventCollectors.create(runRow.address, runRow.tenantId, sessionId, runRow.id);
  }
  return sessionId;
}

/**
 * Ported from workbench's mailbox-persist.ts
 * `createHubPersistMailWithSessionEnsure`: ensures a run's `agent_session`
 * exists before the first mail-triggered write reaches it, since
 * `workflow_run.principal_id` only reconciles onto the trigger that just
 * fired. Best-effort: a failure here must not block the mail upstream is
 * about to persist regardless.
 *
 * The vendored `persistMail` (hub-session-lookups.ts) throws
 * `Endpoint … has no session for address …` when the sender has no session
 * yet — true for a run's first outbound reply. `@corbits/mailbox`'s
 * `createMailboxPersist` re-throws whatever its upstream throws even after
 * its own durable write succeeds, so that throw surfaces as a logged error
 * in the sidecar handler on every first reply. Skip the vendored write
 * instead of letting it throw; `@corbits/mailbox`'s own write already
 * persisted this frame.
 */
export function createHubPersistMailWithSessionEnsure(
  db: DB["db"],
  eventCollectors: EventCollectorPort,
  upstream: (args: MailboxPersistArgs) => Promise<unknown>,
): (args: MailboxPersistArgs) => Promise<unknown> {
  return async (args) => {
    const sender = await resolveRoutableAddress(db, args.senderAddress);
    if (sender !== undefined) {
      try {
        await ensureRunSession({ db, eventCollectors, runId: sender.id });
      } catch (err) {
        console.error(
          `hub.mailboxPersist.ensureRunSession failed for ${args.senderAddress}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sender !== undefined && sender.sessionId === null) {
      return [];
    }
    return upstream(args);
  };
}

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
