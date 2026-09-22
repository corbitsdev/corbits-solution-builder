# @corbits/keychain

Secret storage for a desktop host: the OS keychain via `security(1)` on
macOS, and — where no OS-backed store exists — a 0600 file under the
product's data directory that *says* it is a file rather than pretending to
be a keychain.

The product declares its store once at entrypoint:

```ts
import { configureKeychain, storeSecret, readSecretResult } from "@corbits/keychain";

configureKeychain({
  service: "com.example.product",      // `security -s` name; stable — renaming orphans items
  envPrefix: "EXAMPLE",                // EXAMPLE_SMOKE / EXAMPLE_CREDENTIAL_BACKEND
  dataDirectory: () => resolveDataDir(),
});
await storeSecret("hub:session-token", token);
```

`<envPrefix>_CREDENTIAL_BACKEND=file|keychain` forces a backend, but only in
a recognized test run (`<envPrefix>_SMOKE=1` or `NODE_ENV=test`) — a real
launch that inherited the variable gets a warning and the real backend, so a
keychain is never silently downgraded.

## Surface

- `configureKeychain` / `KeychainConfig` — one-time product declaration.
- `storeSecret` / `readSecretResult` / `secretReference` / `credentialBackend`
  — write, read (`found` | `missing` | `unavailable`), and name a secret.
- `hubEncryptionKeys` — mints/reuses the hub's at-rest encryption keys from
  the environment or this store.

## Reads, not writes

`readSecretResult` distinguishes *missing* from *unavailable*: a locked or
denied keychain is not an empty one, and callers must not treat it as a
reason to mint.
