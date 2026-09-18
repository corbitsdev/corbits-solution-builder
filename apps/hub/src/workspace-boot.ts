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
