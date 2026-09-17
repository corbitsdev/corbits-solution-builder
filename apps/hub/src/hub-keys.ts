/**
 * The hub's at-rest encryption keys.
 *
 * Upstream requires `CREDENTIAL_ENCRYPTION_KEY` and
 * `PRINCIPAL_KEY_ENCRYPTION_KEY` in the environment and fails loudly at boot
 * without them — correct for a deployed service, impossible for a desktop app
 * nobody sets environment variables for.
 *
 * So the host mints them on first run and keeps them in the OS keychain, the
 * same place provider credentials live. The environment still wins when it is
 * set, which is what lets the identical hub run as a hosted service later
 * without changing a line here.
 */
import { derivePublicKeyBytes } from "@intx/crypto";
import { readSecretResult, secretReference, storeSecret } from "./host-secrets.js";

const ACCOUNTS = {
  credential: "hub:credential-encryption-key",
  principal: "hub:principal-key-encryption-key",
  signing: "hub:repo-signing-key",
} as const;

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

export async function hubEncryptionKeys(): Promise<{
  credentialKeyHex: string;
  principalKeyHex: string;
}> {
  return {
    credentialKeyHex: await resolve(ACCOUNTS.credential, "CREDENTIAL_ENCRYPTION_KEY"),
    principalKeyHex: await resolve(ACCOUNTS.principal, "PRINCIPAL_KEY_ENCRYPTION_KEY"),
  };
}

/**
 * The keypair the hub signs its git objects with.
 *
 * Minted per mount, every deploy commit written on one run verifies against a
 * key the next run no longer has. It survives in the keychain beside the other
 * two, so a repo written today still verifies tomorrow.
 *
 * The seed is stored, not the expanded pair: Ed25519 derives the public half
 * from the private one, so keeping both would be storing the same secret twice.
 */
export async function hubSigningKey(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const seed = await resolve(ACCOUNTS.signing, "HUB_REPO_SIGNING_KEY");
  const privateKey = Uint8Array.from(
    seed.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
  return { privateKey, publicKey: await derivePublicKeyBytes(privateKey) };
}
