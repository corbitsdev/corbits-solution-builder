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
 * workspace exists, and per legacy account:
 *
 *   1. probes the account (`provider:<id>` for the API-key providers,
 *      `oauth:<id>` for the two OAuth ones);
 *   2. patches the matching hub credential row with the real secret (a no-op
 *      for the API-key case, whose row already carries it; the fix for the
 *      OAuth case, whose row carried only a pointer);
 *   3. records the move in the workspace tenant's own config, under
 *      `credentialMigration`, so `smoke:upgrade` (and a person debugging a
 *      report) can see it happened — durably, *before* the old entry is
 *      touched, so a crash between the two never loses the audit trail;
 *   4. only then deletes the old entry, so the next boot finds nothing there
 *      and skips straight to a no-op.
 *
 * A crash between steps 3 and 4 leaves the mapping recorded and the old entry
 * still present; the next run sees the account already recorded, skips the
 * patch and the record, and safely retries just the delete — no duplicate
 * mapping, no error.
 *
 * One account's failure — the keychain locked, the hub rejecting the patch —
 * must not stop every other account from migrating, so each is wrapped in its
 * own try/catch; failures are logged and returned, never left to abort the
 * loop silently.
 *
 * Reading the old store here — after `host-secrets.ts` stopped being where a
 * provider secret lives — is not resurrecting it: the module survives for the
 * hub's own bootstrap secrets, and this is the one remaining, clearly-labelled
 * caller that legitimately still needs a raw read of an old-style account.
 */
import { readSecretResult, secretReference, deleteSecret } from "./host-secrets.js";
import { catalog, getTenant, patchTenant, tenantId, type HubCredential, type HubTenant } from "./hub-client.js";
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

export type CredentialMigrationFailure = {
  readonly account: string;
  readonly providerId: string;
  readonly error: string;
};

export type CredentialMigrationResult = {
  readonly migrated: CredentialMigrationEntry[];
  readonly failures: CredentialMigrationFailure[];
};

type CredentialMigrationConfig = {
  readonly mappings: CredentialMigrationEntry[];
};

function credentialRowFor(providerId: string, rows: HubCredential[]): HubCredential | undefined {
  return rows.find((row) => row.name === `provider:${providerId}`);
}

function mappingsOf(tenant: HubTenant | null): CredentialMigrationEntry[] {
  return (tenant?.config?.credentialMigration as CredentialMigrationConfig | undefined)?.mappings ?? [];
}

/**
 * Carries every legacy secret this host's old store still holds into the hub's
 * credential rows. Safe to call on every boot: an account already recorded
 * and emptied by a prior run is skipped entirely; one already recorded but not
 * yet cleaned up (a crash between recording and deleting) only has its
 * leftover old entry removed. Every other account is migrated independently —
 * one failing does not stop the rest.
 */
export async function migrateLegacyProviderCredentials(): Promise<CredentialMigrationResult> {
  const migrated: CredentialMigrationEntry[] = [];
  const failures: CredentialMigrationFailure[] = [];
  const credentialRows = await catalog.credentials();

  let tenant = await getTenant(tenantId());
  let mappings = mappingsOf(tenant);

  for (const { providerId, account } of legacyAccounts()) {
    try {
      const read = await readSecretResult(await secretReference(account));
      if (read.status !== "found") continue;

      const row = credentialRowFor(providerId, credentialRows);
      if (!row) {
        // The old store has a secret but the platform never got a matching
        // catalog row — nothing to carry it into. Leaving the old entry alone
        // is safer than discarding a secret with nowhere to go.
        continue;
      }

      const already = mappings.find((entry) => entry.account === account);
      if (!already) {
        // The hub credential row is patched, and the mapping recorded, before
        // the old entry is touched: a crash here leaves the old entry behind
        // for a harmless retry, never an untracked secret with no audit trail.
        await catalog.patchCredential(row.id, { secret: read.secret, status: "active" });
        const entry: CredentialMigrationEntry = {
          account,
          providerId,
          credentialId: row.id,
          migratedAt: new Date().toISOString(),
        };
        mappings = [...mappings, entry];
        tenant = await patchTenant(tenantId(), {
          config: {
            ...tenant?.config,
            credentialMigration: { mappings } satisfies CredentialMigrationConfig,
          },
        });
        migrated.push(entry);
      }

      await deleteSecret(await secretReference(account));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[credential-migration] ${account} could not be migrated: ${message}`);
      failures.push({ account, providerId, error: message });
    }
  }

  return { migrated, failures };
}
