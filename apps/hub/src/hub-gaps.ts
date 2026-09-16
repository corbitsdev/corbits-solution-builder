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
 *   4. adoptLegacyWorkspace A tenant created before the hub owned identity has
 *                           an owner principal that no user is linked to, and
 *                           none of the owner role and grant `POST /tenants`
 *                           would have created. Nothing lets a user adopt an
 *                           existing tenant, so the rows are repaired here
 *                           once. (Interchange INTR-522, first-operator
 *                           bootstrap, is the native answer.)
 *   5. ensureSpecialistPrincipal
 *                           Closed: the row goes through the principal
 *                           store's `createIfAbsent`, which mints the
 *                           per-principal wrap a raw insert cannot. Only an
 *                           exists-by-id pre-check stays a direct read.
 *   6. ensureAgentSession   `GET /api/me/sessions` is a stub returning [].
 *                           There is no route that creates an `agent_session`
 *                           with a chosen id keyed to a definition. The
 *                           command ledger (`engine-ledger.ts`) is what still
 *                           needs this: it keys its per-project session to
 *                           the seeded lifecycle definition so it can work
 *                           without an offering or a sidecar, which a run's
 *                           own session cannot promise.
 *   7. writeConversationTurn
 *                           No route writes `session_mail` plus the
 *                           `inference_turn` / `turn_part` pair the command
 *                           ledger reads back as one committed command's
 *                           metadata (decision, versions, rationale, the
 *                           run mutations it made). `POST /workflows/:runId/mail`
 *                           triggers a run; it is not a conversation append.
 *   8. listConversationTurns
 *                           No route lists `turn_part` for a session. The
 *                           command ledger reads its own session back through
 *                           this; the me-sessions list is unimplemented.
 *  10. listChildTenants     `GET /api/tenants` does not exist; `/api/me/principals`
 *                           lists memberships, not the tenants under a parent.
 *                           A project is a child tenant, so the list is read here.
 *  11. allocationBinding    `GET /workflows/deployments` projects an allocation's
 *                           status but not the provisioner binding it is pinned
 *                           to, and a deployment bound to another hub address
 *                           is unreachable from this one. The binding is read
 *                           here so such a deployment is not handed back as
 *                           current.
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
import { createPrincipalStore } from "@intx/db";
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

export type PrincipalSeed = {
  id: string;
  tenantId: string;
  kind: "user" | "workflow";
  refId: string;
  status: "active";
};

export type PrincipalIo = {
  exists(id: string): Promise<boolean>;
  create(seed: PrincipalSeed): Promise<unknown>;
};

export function livePrincipalIo(): PrincipalIo {
  return {
    exists: async (id: string) =>
      (
        (await handle().execute(sql`
        SELECT "id" FROM "public"."principal" WHERE "id" = ${id} LIMIT 1
      `)) as unknown as Row[]
      ).length > 0,
    create: async (seed: PrincipalSeed) =>
      createPrincipalStore(hub().db.db, hub().principalKeyStore).createIfAbsent(seed),
  };
}

export async function ensurePrincipal(seed: PrincipalSeed, io: PrincipalIo): Promise<void> {
  if (await io.exists(seed.id)) return;
  // A null return is the store's lost-the-race signal: another writer claimed
  // the natural key first, which still leaves a row for the identity.
  await io.create(seed);
}

const MAIL_DOMAIN = "local.solutions-builder.invalid";

function addressOf(principalId: string): string {
  return `${principalId}@${MAIL_DOMAIN}`;
}

/**
 * Registers the specialist's platform identity, once. A `principal` row is
 * what a signing key and a session both attach to; `kind: "workflow"` is the
 * enum's own name for "a workflow speaks as this". The row goes through the
 * principal store, which derives the per-principal wrap from the sealed KEK;
 * a raw insert cannot mint that wrap. The exists-by-id pre-check stays a
 * direct read: only the id is known (a real user row's refId is its auth
 * user, not its id), so the store's natural-key upsert cannot express "this
 * exact row exists".
 */
export async function ensureSpecialistPrincipal(
  tenantId: string,
  io: PrincipalIo = livePrincipalIo(),
): Promise<void> {
  await ensurePrincipal(
    {
      id: SPECIALIST_PRINCIPAL_ID,
      tenantId,
      kind: "workflow",
      refId: "solutions-builder.specialist",
      status: "active",
    },
    io,
  );
}

// --- 10. listChildTenants ----------------------------------------------------

export type ChildTenant = {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  createdAt: Date;
};

/** Every tenant whose parent is `parentId`, oldest first. */
export async function listChildTenants(parentId: string): Promise<ChildTenant[]> {
  const rows = (await handle().execute(sql`
    SELECT "id", "name", "config", "created_at"
    FROM "public"."tenant"
    WHERE "parent_id" = ${parentId}
    ORDER BY "created_at" ASC
  `)) as unknown as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    config: (row.config as Record<string, unknown> | null) ?? null,
    createdAt: new Date(row.created_at as string),
  }));
}

/** A user principal by id. Same gap: nothing creates a principal except signup or invite. */
export async function ensureUserPrincipal(
  tenantId: string,
  principalId: string,
  io: PrincipalIo = livePrincipalIo(),
): Promise<void> {
  await ensurePrincipal(
    { id: principalId, tenantId, kind: "user", refId: principalId, status: "active" },
    io,
  );
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


// --- 9. writeWorkflowSourceTree / readWorkflowSourceBlob --------------------

/**
 * UPSTREAM_GAP: the hub creates a `workflow` asset over HTTP but offers no
 * route that writes its source tree short of git smart-HTTP. The asset
 * service's own `populateAsset` is the in-process seam, the same one
 * Workbench's agent directory commits through. Upstream ask: a JSON
 * "write tree" route on `/assets/:assetId`.
 */
export async function writeWorkflowSourceTree(args: {
  assetId: string;
  files: Record<string, string>;
  message: string;
}): Promise<{ commitSha: string }> {
  return hub().assetService.populateAsset({
    assetId: args.assetId,
    ref: "refs/heads/main",
    principal: { kind: "hub" },
    tree: { files: args.files, message: args.message },
  });
}

/** The bytes at `path` on the asset's main branch, or null when absent. */
export async function readWorkflowSourceBlob(assetId: string, path: string): Promise<string | null> {
  try {
    const bytes = await hub().assetService.readAssetBlob({ assetId, path });
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// --- 11. allocationBinding --------------------------------------------------

/** The provisioner binding fingerprint of the deployment's sidecar allocation, or null without one. */
export async function allocationBinding(anchorRunId: string): Promise<string | null> {
  const rows = (await handle().execute(sql`
    SELECT "provisioner_binding_fingerprint"
    FROM "public"."sidecar_allocation"
    WHERE "anchor_run_id" = ${anchorRunId}
    LIMIT 1
  `)) as unknown as Row[];
  const row = rows[0];
  return row ? String(row.provisioner_binding_fingerprint) : null;
}
