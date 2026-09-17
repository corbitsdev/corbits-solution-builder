/**
 * The hub's at-rest keys that still live next to the host.
 *
 * Interchange's credential and principal encryption keys are owned by
 * `@solutions-builder/keychain`: minted into the OS keychain on first run,
 * with the environment still winning when it is set. The repo-signing seed
 * stays here — it is not one of those two cipher keys, and this package
 * does not take on owner-password minting either.
 */
import { derivePublicKeyBytes } from "@intx/crypto";
import { readSecretResult, secretReference, storeSecret } from "./host-secrets.js";

export { hubEncryptionKeys } from "@solutions-builder/keychain";

const SIGNING_ACCOUNT = "hub:repo-signing-key";

function mintHexKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function resolveSigningSeed(): Promise<string> {
  const fromEnvironment = process.env.HUB_REPO_SIGNING_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  const stored = await readSecretResult(await secretReference(SIGNING_ACCOUNT));
  if (stored.status === "found" && stored.secret.length === 64) return stored.secret;

  // A store that cannot answer is not an empty store. Minting here would write
  // a new key over a good one — and every signed commit would fail to verify.
  if (stored.status === "unavailable") {
    throw new Error(
      `The keychain could not be read for ${SIGNING_ACCOUNT}: ${stored.detail}. ` +
        "Nothing has been changed. Unlock the keychain, or allow this app access, " +
        "and start it again — minting a replacement key here would make the " +
        "existing credentials and signed history unreadable.",
    );
  }

  const minted = mintHexKey();
  await storeSecret(SIGNING_ACCOUNT, minted);
  return minted;
}

/**
 * The keypair the hub signs its git objects with.
 *
 * Minted per mount, every deploy commit written on one run verifies against a
 * key the next run no longer has. It survives in the keychain beside the
 * encryption keys, so a repo written today still verifies tomorrow.
 *
 * The seed is stored, not the expanded pair: Ed25519 derives the public half
 * from the private one, so keeping both would be storing the same secret twice.
 */
export async function hubSigningKey(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}> {
  const seed = await resolveSigningSeed();
  const privateKey = Uint8Array.from(
    seed.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );
  return { privateKey, publicKey: await derivePublicKeyBytes(privateKey) };
}
