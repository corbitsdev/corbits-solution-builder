/**
 * The host's own bootstrap secrets, stored through
 * `@corbits/keychain`'s store primitives (`security(1)` on macOS,
 * a 0600 file fallback everywhere else — see `packages/keychain/src/store.ts`
 * for the mechanics; account names and the service id are unchanged, so a
 * secret written before this module re-exported them still reads).
 *
 * This is not where a *provider* credential lives — those are Interchange's
 * own `credential` table rows, sealed with its own credential cipher, so
 * delegation and the hub's own resolution govern them the same way a
 * deployed workflow's do. What stays here is genuinely circular otherwise:
 * the hub's repo-signing seed (`hub-keys.ts`) — a secret that cannot itself
 * live in a row the encryption keys would have to decrypt. The two
 * Interchange at-rest encryption keys, minted the same way, live in
 * `@corbits/keychain` directly.
 */
export {
  credentialBackend,
  readSecretResult,
  secretReference,
  storeSecret,
  type CredentialBackend,
  type SecretRead,
} from "@corbits/keychain";
