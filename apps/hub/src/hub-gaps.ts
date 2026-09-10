/**
 * The platform writes this host still makes directly, because no hub route
 * does them yet. Every function here is an upstream ask, not a design.
 *
 * UPSTREAM_GAP — each is named so the list is greppable and the file shrinks
 * as routes land:
 *
 *   1. registerDefinition   A workflow definition can only be created through
 *                           `POST /workflows/deployments`, which evaluates
 *                           source on a probe sidecar. There is no route that
 *                           registers a definition row a client generated
 *                           itself, so the row is inserted here.
 *   2. bindAgentRole        `agent_role` (a definition bound to a role) has no
 *                           route; principal roles do, agent roles do not.
 *   3. writeDefinitionBody  A definition's body — the system prompt — is a
 *                           commit in the hub's git registry. Sidecars push it
 *                           over smart HTTP with a git token; a client has no
 *                           route to write it, so the repo store is used.
 *   4. adoptLegacyWorkspace A tenant created before the hub owned identity has
 *                           an owner principal that no user is linked to, and
 *                           none of the owner role and grant `POST /tenants`
 *                           would have created. Nothing lets a user adopt an
 *                           existing tenant, so the rows are repaired here
 *                           once. (Interchange INTR-522, first-operator
 *                           bootstrap, is the native answer.)
 *   5. ensureSpecialistPrincipal
 *                           No `POST /api/tenants/:id/principals` for
 *                           `kind: "workflow"`. Principals are listed and
 *                           patched, not created.
 *   6. ensureAgentSession   `GET /api/me/sessions` is a stub returning [].
 *                           There is no route that creates an `agent_session`
 *                           with a chosen id keyed to a definition.
 *   7. writeConversationTurn
 *                           No route writes `session_mail` plus the
 *                           `inference_turn` / `turn_part` pair a stage thread
 *                           reads back, including Builder metadata (quotes,
 *                           resultNodeId, questions, `kind: "brief"`).
 *                           `POST /workflows/:runId/mail` triggers a run; it
 *                           is not a conversation append.
 *   8. listConversationTurns
 *                           No route lists `turn_part` for a session. The
 *                           me-sessions list is unimplemented.
 *   9. createHubServer      The vendored tree ships `@intx/hub-api`
 *                           (`createApp`, `createAuth`) and
 *                           `@intx/hub-sessions`, not Interchange's
 *                           `apps/hub/src/server.ts`. There is no
 *                           `createHubServer` that accepts an injected pglite
 *                           handle and keychain keys, so `hub-mount.ts`
 *                           composes those factories itself.
 *
 * Everything else the host asks of the platform goes through `hub-client.ts`.
 */
import { and, eq, sql, type Column } from "drizzle-orm";
import { createDetachedSignatureWithSigner } from "@intx/crypto";
import { assembleMessage, assembleSignedContent, generateMessageId } from "@intx/mime";
import { hub } from "./hub-mount.js";
import { LEGACY_TENANT_ID } from "./hub-client.js";
import { newId } from "./ids.js";

type Row = Record<string, unknown>;
type Handle = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Row[]> & {
        orderBy: (order: unknown) => Promise<Row[]>;
      };
    };
  };
  insert: (table: unknown) => {
    values: (row: unknown) => Promise<unknown> & { onConflictDoNothing: () => Promise<unknown> };
  };
  execute: (query: unknown) => Promise<unknown>;
};

function handle(): Handle {
  return hub().db.db as unknown as Handle;
}

// --- 1. registerDefinition -------------------------------------------------

export type DefinitionRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly wireHash: string;
  readonly grantRequirements?: readonly unknown[];
};

/**
 * Writes a definition row unless one with the same wire hash already exists
 * under that name. An unchanged definition is a no-op; a changed one is a new
 * version, and running instances stay on the version they started with.
 */
export async function registerDefinition(
  tenantId: string,
  row: DefinitionRow,
): Promise<{ id: string; created: boolean }> {
  const { workflowDefinition } = await import("@intx/db/schema");
  const db = handle();
  const columns = workflowDefinition as unknown as { tenantId: Column; name: Column };

  const existing = await db
    .select()
    .from(workflowDefinition)
    .where(and(eq(columns.tenantId, tenantId), eq(columns.name, row.name)));
  const current = existing.find((entry) => entry.wireHash === row.wireHash);
  if (current) return { id: String(current.id), created: false };

  await db.insert(workflowDefinition).values({
    id: row.id,
    tenantId,
    name: row.name,
    description: row.description,
    wireHash: row.wireHash,
    ...(row.grantRequirements && row.grantRequirements.length > 0
      ? { grantRequirements: row.grantRequirements }
      : {}),
  });
  return { id: row.id, created: true };
}

// --- 2. bindAgentRole ------------------------------------------------------

/** Binds a definition to a role. Idempotent. */
export async function bindAgentRole(definitionId: string, roleId: string): Promise<void> {
  const { agentRole } = await import("@intx/db/schema");
  await handle().insert(agentRole).values({ agentId: definitionId, roleId }).onConflictDoNothing();
}

// --- 3. writeDefinitionBody ------------------------------------------------

export type DeployedBody = {
  readonly definitionId: string;
  readonly commitSha: string;
};

/**
 * Commits one system prompt per definition to the hub's registry, on the
 * deploy ref a sidecar pulls from. Content-addressed by git, so an unchanged
 * prompt produces the same tree; the sha is what tells two runs apart.
 */
export async function deployDefinitionBodies(
  bodies: readonly { definitionId: string; systemPrompt: string }[],
): Promise<DeployedBody[]> {
  const store = hub().agentRepoStore;
  const written: DeployedBody[] = [];
  for (const body of bodies) {
    // Serialized deliberately: the store's contract is that the caller does
    // not write two commits to one agent's repo concurrently.
    const { commitSha } = await store.writeDeployTree(body.definitionId, {
      systemPrompt: body.systemPrompt,
    });
    written.push({ definitionId: body.definitionId, commitSha });
  }
  return written;
}

/** The packfile a sidecar would pull for this definition, as proof it is there. */
export async function deployedPack(
  definitionId: string,
): Promise<{ bytes: number; commitSha: string; ref: string } | null> {
  const pack = await hub().agentRepoStore.createDeployPack(definitionId).catch(() => null);
  return pack ? { bytes: pack.pack.length, commitSha: pack.commitSha, ref: pack.ref } : null;
}

// --- 4. adoptLegacyWorkspace -----------------------------------------------

/**
 * Links a pre-identity workspace to the owner user, once.
 *
 * Returns whether a legacy tenant existed. After this the tenant looks the way
 * `POST /api/tenants` would have left it: the owner is a user-linked
 * principal holding an `owner` role with an allow-everything grant, so every
 * later call can go through the hub's API like a fresh install's does.
 */
export async function adoptLegacyWorkspace(userId: string): Promise<boolean> {
  const db = handle();
  const { tenant } = await import("@intx/db/schema");
  const tenants = await db
    .select()
    .from(tenant)
    .where(eq((tenant as unknown as { id: Column }).id, LEGACY_TENANT_ID));
  if (tenants.length === 0) return false;

  // The principal the old boot created, whose ref was its own id.
  await db.execute(sql`
    UPDATE "public"."principal" SET "ref_id" = ${userId}, "updated_at" = now()
    WHERE "tenant_id" = ${LEGACY_TENANT_ID} AND "kind" = 'user' AND "ref_id" = 'p_owner'
  `);
  const [owner] = (await db.execute(sql`
    SELECT "id" FROM "public"."principal"
    WHERE "tenant_id" = ${LEGACY_TENANT_ID} AND "kind" = 'user' AND "ref_id" = ${userId}
    LIMIT 1
  `)) as unknown as { id: string }[];
  if (!owner) return true;

  const roleId = `role_owner_${LEGACY_TENANT_ID}`;
  await db.execute(sql`
    INSERT INTO "public"."role" ("id","tenant_id","name","description","is_system")
    VALUES (${roleId}, ${LEGACY_TENANT_ID}, 'owner', 'System owner role', true)
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "public"."grant" ("id","tenant_id","role_id","resource","action","effect","origin")
    VALUES (${`grant_owner_${LEGACY_TENANT_ID}`}, ${LEGACY_TENANT_ID}, ${roleId}, '*', '*', 'allow', 'system')
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "public"."principal_role" ("principal_id","role_id")
    VALUES (${owner.id}, ${roleId})
    ON CONFLICT DO NOTHING
  `);
  return true;
}

// --- 5. ensureSpecialistPrincipal ------------------------------------------

export const SPECIALIST_PRINCIPAL_ID = "p_specialist";

const MAIL_DOMAIN = "local.solutions-builder.invalid";

function addressOf(principalId: string): string {
  return `${principalId}@${MAIL_DOMAIN}`;
}

/**
 * Registers the specialist's platform identity, once. A `principal` row is
 * what a signing key and a session both attach to; `kind: "workflow"` is the
 * enum's own name for "a workflow speaks as this".
 */
export async function ensureSpecialistPrincipal(tenantId: string): Promise<void> {
  await handle().execute(sql`
    INSERT INTO "public"."principal" ("id","tenant_id","kind","ref_id","status")
    VALUES (${SPECIALIST_PRINCIPAL_ID}, ${tenantId}, 'workflow', 'solutions-builder.specialist', 'active')
    ON CONFLICT ("id") DO NOTHING
  `);
}

/** A user principal by id. Same gap: nothing creates a principal except signup or invite. */
export async function ensureUserPrincipal(tenantId: string, principalId: string): Promise<void> {
  await handle().execute(sql`
    INSERT INTO "public"."principal" ("id","tenant_id","kind","ref_id","status")
    VALUES (${principalId}, ${tenantId}, 'user', ${principalId}, 'active')
    ON CONFLICT ("id") DO NOTHING
  `);
}

async function ensureSigningKey(principalId: string): Promise<void> {
  try {
    await hub().principalKeyStore.generate(principalId);
  } catch {
    // The partial unique index on (principalId, active) is what makes this
    // idempotent: a principal that already has an active key throws here,
    // which is exactly "nothing to do".
  }
}

// --- 6. ensureAgentSession -------------------------------------------------

/** Finds or creates an `agent_session` with a chosen id keyed to a definition. */
export async function ensureAgentSession(args: {
  sessionId: string;
  tenantId: string;
  definitionId: string;
  principalId: string;
}): Promise<void> {
  await handle().execute(sql`
    INSERT INTO "public"."agent_session" ("id","tenant_id","agent_id","principal_id","status")
    VALUES (${args.sessionId}, ${args.tenantId}, ${args.definitionId}, ${args.principalId}, 'active')
    ON CONFLICT ("id") DO NOTHING
  `);
}

// --- 7. writeConversationTurn ----------------------------------------------

async function buildRawMail(args: {
  sessionId: string;
  tenantId: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  body: string;
}): Promise<Uint8Array> {
  await ensureSigningKey(args.fromPrincipalId);
  const from = addressOf(args.fromPrincipalId);

  const signedContent = assembleSignedContent({ kind: "conversation", text: args.body });
  const signature = await createDetachedSignatureWithSigner(signedContent, (input) =>
    hub().principalKeyStore.sign(args.fromPrincipalId, input),
  );

  return assembleMessage(
    {
      from,
      to: [addressOf(args.toPrincipalId)],
      cc: undefined,
      date: new Date(),
      messageId: generateMessageId(from),
      subject: undefined,
      inReplyTo: undefined,
      references: undefined,
      mimeVersion: "1.0",
      interchangeType: "conversation.message",
      interchangeCorrelationId: undefined,
      interchangeTenantId: args.tenantId,
      interchangeAgentId: undefined,
      interchangeSessionId: args.sessionId,
      interchangeOfferingId: undefined,
      interchangeSchemaVersion: undefined,
      traceparent: undefined,
      tracestate: undefined,
    },
    signedContent,
    signature,
  );
}

/**
 * Writes one turn: the mail record the platform expects, and the
 * inference-turn/turn-part pair this host reads back from.
 */
export async function writeConversationTurn(args: {
  sessionId: string;
  tenantId: string;
  runId: string;
  role: "human" | "specialist";
  body: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  metadata: Record<string, unknown>;
  model: string;
}): Promise<string> {
  const raw = await buildRawMail({
    sessionId: args.sessionId,
    tenantId: args.tenantId,
    fromPrincipalId: args.fromPrincipalId,
    toPrincipalId: args.toPrincipalId,
    body: args.body,
  });

  const mailId = newId.message();
  const turnId = newId.inferenceTurn();
  const partId = newId.turnPart();
  const now = new Date();

  const { sessionMail, inferenceTurn, turnPart } = await import("@intx/db/schema");
  const db = handle();

  // Sequential inserts, not one `db.transaction`: `hub().db.db` is a drizzle
  // binding over the same single-writer pglite connection the rest of the
  // host uses, and a caller elsewhere in the host may already be inside its
  // own transaction on that connection when this runs. Opening a second,
  // nested transaction here is exactly the shape that hangs.
  //
  // The order carries the safety instead. The read path is `inference_turn`
  // joined to `turn_part`, and the turn's words live on the part — those two
  // go first, so an interrupted write leaves either nothing or a whole,
  // readable turn. `session_mail` is the platform's mirror and goes last.
  await db
    .insert(inferenceTurn)
    .values({
      id: turnId,
      sessionId: args.sessionId,
      runId: args.runId,
      tenantId: args.tenantId,
      model: args.model,
      status: "completed",
      startedAt: now,
      endedAt: now,
    })
    .onConflictDoNothing();

  const existing = await db
    .select()
    .from(turnPart)
    .where(eq((turnPart as unknown as { sessionId: Column }).sessionId, args.sessionId));
  const ordinal = existing.reduce((high, row) => Math.max(high, (Number(row.ordinal) || 0) + 1), 0);

  await db
    .insert(turnPart)
    .values({
      id: partId,
      turnId,
      sessionId: args.sessionId,
      type: "text",
      content: args.body,
      metadata: args.metadata,
      ordinal,
    })
    .onConflictDoNothing();
  await db
    .insert(sessionMail)
    .values({
      id: mailId,
      sessionId: args.sessionId,
      runId: null,
      tenantId: args.tenantId,
      direction: args.role === "human" ? "inbound" : "outbound",
      status: "delivered",
      raw,
      createdAt: now,
    })
    .onConflictDoNothing();

  return partId;
}

// --- 8. listConversationTurns ----------------------------------------------

export type ConversationPart = {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  startedAt: string;
};

/** Every part on a session, oldest turn first. */
export async function listConversationTurns(sessionId: string): Promise<ConversationPart[]> {
  const { inferenceTurn, turnPart } = await import("@intx/db/schema");
  const db = handle();
  const partColumns = turnPart as unknown as { sessionId: Column };
  const turnColumns = inferenceTurn as unknown as { sessionId: Column };

  const [parts, turns] = await Promise.all([
    db.select().from(turnPart).where(eq(partColumns.sessionId, sessionId)),
    db.select().from(inferenceTurn).where(eq(turnColumns.sessionId, sessionId)),
  ]);

  const startedAt = new Map(
    turns.map((turn) => [String(turn.id), turn.startedAt instanceof Date ? turn.startedAt : new Date(String(turn.startedAt ?? 0))]),
  );

  return parts
    .map((part) => {
      const when = startedAt.get(String(part.turnId)) ?? new Date(0);
      return {
        id: String(part.id),
        content: typeof part.content === "string" ? part.content : "",
        metadata: (part.metadata as Record<string, unknown> | null) ?? null,
        startedAt: when.toISOString(),
        when,
        ordinal: Number(part.ordinal) || 0,
      };
    })
    .sort(
      (a, b) => a.when.getTime() - b.when.getTime() || a.ordinal - b.ordinal || a.id.localeCompare(b.id),
    )
    .map(({ when: _when, ordinal: _ordinal, ...part }) => {
      void _when;
      void _ordinal;
      return part;
    });
}

