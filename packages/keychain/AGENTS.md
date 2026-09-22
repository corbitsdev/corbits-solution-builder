# @corbits/keychain

Secret storage primitives. The rules that keep it honest and reusable:

- **No product strings.** `service`, `envPrefix` and the data directory
  arrive through `configureKeychain`; a literal product name in `src/` is a
  bug.
- **Unavailable is not missing.** Never mint over a store that could not
  answer; `readSecretResult` exists so callers can tell the difference.
- **The file fallback says so.** A fallback that pretends to be a keychain
  is worse than one that admits what it is — `secretReference`/`credentialBackend`
  always report the real backend.
- **Secrets never reach a log, response, artifact, or prompt.**
- **The test override is test-only.** `<envPrefix>_CREDENTIAL_BACKEND` is
  honored only under `<envPrefix>_SMOKE=1`/`NODE_ENV=test`; do not widen that.
