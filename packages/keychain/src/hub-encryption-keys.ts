/**
 * The hub's at-rest encryption keys.
 *
 * Upstream requires `CREDENTIAL_ENCRYPTION_KEY` and
 * `PRINCIPAL_KEY_ENCRYPTION_KEY` in the environment and fails loudly at boot
 * without them — correct for a deployed service, impossible for a desktop app
 * nobody sets environment variables for.
 *
 * So the host mints them on first run and keeps them in the OS keychain.
 * The environment still wins when it is set, which is what lets the identical
 * hub run as a hosted service later without changing a line here.
 *
 * This package does not mint the workspace owner password or any other host
 * secret. Those stay in the host runtime (`@corbits/embedded-host`).
 */
import { readSecretResult, secretReference, storeSecret } from "./store.js";

const ACCOUNTS = {
  credential: "hub:credential-encryption-key",
  principal: "hub:principal-key-encryption-key",
} as const;

export type HubEncryptionKeys = {
  credentialKeyHex: string;
  principalKeyHex: string;
};

function mintHexKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolve(account: string, environmentName: string): Promise<string> {
  const fromEnvironment = process.env[environmentName]?.trim();
  if (fromEnvironment) return fromEnvironment;

  const stored = await readSecretResult(await secretReference(account));
  if (stored.status === "found" && stored.secret.length === 64) return stored.secret;

  // A store that cannot answer is not an empty store. Minting here would write
  // a new key over a good one — and everything sealed under the old one, every
  // provider credential and every signed commit, would be unreadable. A locked
  // keychain, or one prompt someone clicked Deny on, is exactly this case.
  if (stored.status === "unavailable") {
    throw new Error(
      `The keychain could not be read for ${account}: ${stored.detail}. ` +
        "Nothing has been changed. Unlock the keychain, or allow this app access, " +
        "and start it again — minting a replacement key here would make the " +
        "existing credentials and signed history unreadable.",
    );
  }

  // First run on this machine. A minted key is written before it is used, so a
  // crash between minting and storing cannot leave secrets sealed under a key
  // that no longer exists.
  const minted = mintHexKey();
  await storeSecret(account, minted);
  return minted;
}

export async function hubEncryptionKeys(): Promise<HubEncryptionKeys> {
  return {
    credentialKeyHex: await resolve(ACCOUNTS.credential, "CREDENTIAL_ENCRYPTION_KEY"),
    principalKeyHex: await resolve(ACCOUNTS.principal, "PRINCIPAL_KEY_ENCRYPTION_KEY"),
  };
}
