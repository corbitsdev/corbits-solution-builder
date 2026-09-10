/**
 * Registering a connected provider as an Interchange credential — §5.
 *
 * §5: "Persist refresh/access material through an OS-backed secure credential
 * facility integrated with verified Interchange credential references; no
 * parallel identity/password store."
 *
 * Both halves matter. The secret stays in the OS keychain, so this writes a
 * *reference* — `keychain:provider:anthropic` — and never the material itself.
 * And the row exists at all so the hub can authorise a capability against a
 * credential it owns: without it, connecting a provider would furnish the
 * host privately and leave everything the hub launches unable to see that
 * anything had been connected.
 */
import { and, eq } from "drizzle-orm";
import { hub } from "./mount.js";
import { LOCAL_TENANT } from "../store/projects.js";

export type CredentialLink = {
  readonly id: string;
  readonly created: boolean;
};

/**
 * Records, or updates, the credential the hub knows this provider by.
 *
 * `secret` carries the reference, not the secret. The column is not optional
 * upstream, and a reference is the honest thing to put in it: anything that
 * reads this row and expects material gets a string that is plainly a pointer.
 */
export async function linkProviderCredential(input: {
  providerId: string;
  label: string;
  kind: "api_key" | "oauth" | "local_endpoint";
  credentialRef: string | null;
  baseUrl?: string;
  scopes?: string[];
}): Promise<CredentialLink | null> {
  // A local endpoint has nothing to hold: no account, no key, nothing to
  // revoke. Registering an empty credential for it would be a lie of tidiness.
  if (input.kind === "local_endpoint" || !input.credentialRef) return null;

  const { credential } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as {
    select: () => {
      from: (table: unknown) => {
        where: (predicate: unknown) => Promise<{ id: string }[]>;
      };
    };
    insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
    update: (table: unknown) => {
      set: (row: unknown) => { where: (predicate: unknown) => Promise<unknown> };
    };
  };

  const columns = credential as unknown as { tenantId: unknown; name: unknown };
  const name = `provider:${input.providerId}`;

  // A credential belongs to a provider — `credential.provider_id` is NOT NULL
  // and references `provider`. Writing the credential without one failed on
  // every connection, and the failure was logged rather than raised, so the
  // hub has never actually held the reference. The provider row is created
  // first, and named the same way, so the two stay findable together.
  const providerId = await ensureProviderRow(db, input.providerId, input.label, input.baseUrl);
  const existing = await db
    .select()
    .from(credential)
    .where(and(eq(columns.tenantId as never, LOCAL_TENANT), eq(columns.name as never, name)));

  const row = {
    tenantId: LOCAL_TENANT,
    providerId,
    name,
    type: input.kind === "oauth" ? "oauth_token" : "api_key",
    description: `${input.label}, held in the OS keychain. This row carries the reference, never the secret.`,
    secret: input.credentialRef,
    // A (re)connection is validated before this is ever called, so it is
    // recorded as active — and, on a reconnect, as active again even if the
    // previous key had gone stale. `updatedAt` is this row's only health
    // timestamp, so it is bumped explicitly; the column default only fires
    // on insert.
    status: "active" as const,
    updatedAt: new Date(),
    ...(input.scopes ? { scopes: input.scopes } : {}),
  };

  if (existing[0]) {
    await db.update(credential).set(row).where(eq((credential as never as { id: unknown }).id as never, existing[0].id));
    return { id: existing[0].id, created: false };
  }

  const id = `cred_${name.replace(/[^a-z0-9]+/gi, "_")}`;
  await db.insert(credential).values({ id, ...row });
  return { id, created: true };
}

/** The `provider` row a credential hangs from, created once per vendor. */
async function ensureProviderRow(
  db: {
    select: () => {
      from: (table: unknown) => {
        where: (predicate: unknown) => Promise<{ id: string }[]>;
      };
    };
    insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
  },
  providerId: string,
  label: string,
  baseUrl?: string,
): Promise<string> {
  const { provider } = await import("@intx/db/schema");
  const columns = provider as unknown as { tenantId: unknown; name: unknown };
  const existing = await db
    .select()
    .from(provider)
    .where(and(eq(columns.tenantId as never, LOCAL_TENANT), eq(columns.name as never, providerId)));
  if (existing[0]) return existing[0].id;

  const id = `prv_${providerId.replace(/[^a-z0-9]+/gi, "_")}`;
  await db.insert(provider).values({
    id,
    tenantId: LOCAL_TENANT,
    name: providerId,
    plugin: providerId,
    ...(baseUrl ? { apiBaseUrl: baseUrl } : {}),
    metadata: { label },
  });
  return id;
}
