/**
 * Host-only repairs the installer package cannot do: they touch the
 * database and the keychain.
 *
 * Legacy-tenant adoption and credential carry stay here. Creating the
 * workspace tenant is the installer's (or first-run client's) job; boot
 * no longer requires one before listen, and it does not mint an owner.
 */
import { database } from "./db.js";
import { adoptLegacyWorkspace } from "./hub-migrate.js";
import {
  hubGet,
  hubMode,
  LEGACY_TENANT_ID,
  resolveWorkspace,
} from "./hub-client.js";
import { migrateLegacyProviderCredentials } from "./credential-migration.js";

/**
 * The one-time repair for a tenant created before the hub owned identity:
 * adopts it as the signed-in principal's, once, so its projects keep their
 * tenant. A no-op once the legacy tenant is gone or already adopted (or
 * there never was one), so it is safe to call on every install.
 */
export async function adoptLegacyWorkspaceOnce(): Promise<void> {
  if (hubMode() !== "embedded") return;
  if (await resolveWorkspace()) return;
  const me = await hubGet<{ id: string }>("/api/me");
  await adoptLegacyWorkspace(database(), me.id, LEGACY_TENANT_ID);
}

/**
 * CL-8076: the one-time carry of a pre-upgrade keychain/file provider secret
 * into the hub's own credential row (`credential-migration.ts`). Reads the OS
 * keychain and the hub's raw secret store directly, so it cannot live in the
 * installer package. Safe on every install: an old store already emptied by a
 * prior run has nothing left to carry.
 */
export async function migrateCredentialsOnce(): Promise<void> {
  const result = await migrateLegacyProviderCredentials().catch((cause: unknown) => {
    // A per-account failure is already caught and reported inside
    // `migrateLegacyProviderCredentials`; this only catches something that
    // failed before any account could be tried (the tenant or catalog reads
    // themselves), so the rest of install still proceeds.
    console.error(
      `[credential-migration] could not carry legacy provider secrets forward: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  });
  if (result && result.failures.length > 0) {
    console.error(
      `[credential-migration] ${result.failures.length} legacy account(s) could not be migrated ` +
        `this run and will be retried on the next boot: ` +
        result.failures.map((failure) => `${failure.account} (${failure.error})`).join("; "),
    );
  }
}
