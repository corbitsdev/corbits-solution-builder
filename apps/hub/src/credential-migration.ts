/**
 * CL-8076: carries a pre-upgrade provider secret out of the OS keychain/file
 * store and into the hub's own credential row, once.
 *
 * Before this ticket, a connected provider's real secret lived twice: sealed
 * into Interchange's `credential` row (an API key only — an OAuth row held a
 * useless keychain-reference string as its "secret"), and again in the
 * keychain/file store `host-secrets.ts` still keeps for the hub's own
 * bootstrap secrets. A workspace that connected a provider before this
 * shipped still has that old copy, and an OAuth row still carries the
 * pointer instead of usable material — so this runs once, at boot, after the
 * workspace exists, and:
 *
 *   1. probes the known legacy accounts (`provider:<id>` for the API-key
 *      providers, `oauth:<id>` for the two OAuth ones);
 *   2. for whatever is still found there, patches the matching hub
 *      credential row with the real secret (a no-op for the API-key case,
 *      whose row already carries it; the fix for the OAuth case, whose row
 *      carried only a pointer);
 *   3. deletes the old entry, so the next boot finds nothing there and skips
 *      it — the idempotence is "the old store is empty", not a flag;
 *   4. records what moved in the workspace tenant's own config, under
 *      `credentialMigration`, so `smoke:upgrade` (and a person debugging a
 *      report) can see it happened.
 *
 * Reading the old store here — after `host-secrets.ts` stopped being where a
 * provider secret lives — is not resurrecting it: the module survives for the
 * hub's own bootstrap secrets, and this is the one remaining, clearly-labelled
 * caller that legitimately still needs a raw read of an old-style account.
 */
import { readSecretResult, secretReference, deleteSecret } from "./host-secrets.js";
import { catalog, getTenant, patchTenant, tenantId, type HubCredential } from "./hub-client.js";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth.js";

/** Every provider id CL-8076-era code ever wrote a keychain/file secret under. */
const LEGACY_API_KEY_PROVIDER_IDS = ["anthropic", "openai", "openrouter", "xai", "compatible"] as const;

type LegacyAccount = { readonly providerId: string; readonly account: string };

function legacyAccounts(): LegacyAccount[] {
  return [
    ...LEGACY_API_KEY_PROVIDER_IDS.map((providerId) => ({ providerId, account: `provider:${providerId}` })),
    ...OAUTH_PROVIDERS.map((id: OAuthProviderId) => ({ providerId: id, account: `oauth:${id}` })),
  ];
}

export type CredentialMigrationEntry = {
  readonly account: string;
  readonly providerId: string;
  readonly credentialId: string;
  readonly migratedAt: string;
};

type CredentialMigrationConfig = {
  readonly mappings: CredentialMigrationEntry[];
};

function credentialRowFor(providerId: string, rows: HubCredential[]): HubCredential | undefined {
  return rows.find((row) => row.name === `provider:${providerId}`);
}

/**
 * Carries every legacy secret this host's old store still holds into the hub's
 * credential rows. Safe to call on every boot: an account already emptied by a
 * prior run reads as missing and is skipped, so a second call does nothing.
 */
export async function migrateLegacyProviderCredentials(): Promise<CredentialMigrationEntry[]> {
  const migrated: CredentialMigrationEntry[] = [];
  const credentialRows = await catalog.credentials();

  for (const { providerId, account } of legacyAccounts()) {
    const read = await readSecretResult(await secretReference(account));
    if (read.status !== "found") continue;

    const row = credentialRowFor(providerId, credentialRows);
    if (!row) {
      // The old store has a secret but the platform never got a matching
      // catalog row — nothing to carry it into. Leaving the old entry alone
      // is safer than discarding a secret with nowhere to go.
      continue;
    }

    await catalog.patchCredential(row.id, { secret: read.secret, status: "active" });
    await deleteSecret(await secretReference(account));
    migrated.push({ account, providerId, credentialId: row.id, migratedAt: new Date().toISOString() });
  }

  if (migrated.length > 0) await recordMigration(migrated);
  return migrated;
}

async function recordMigration(entries: CredentialMigrationEntry[]): Promise<void> {
  const tenant = await getTenant(tenantId());
  const existing = (tenant?.config?.credentialMigration as CredentialMigrationConfig | undefined) ?? {
    mappings: [],
  };
  await patchTenant(tenantId(), {
    config: {
      ...tenant?.config,
      credentialMigration: {
        mappings: [...existing.mappings, ...entries],
      } satisfies CredentialMigrationConfig,
    },
  });
}
