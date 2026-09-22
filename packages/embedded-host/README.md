# @corbits/embedded-host

The host process runtime a desktop product composes to embed an Interchange
hub: loopback server, session-token handshake, pglite database, vendored hub
migrations, keychain-backed secrets and keys, the hub mount, sidecar reaping,
and lifecycle.

A product's entrypoint declares its identity and routes; the package owns the
process:

```ts
import { initHost, serveHost } from "@corbits/embedded-host";

initHost(identity); // appDir, envPrefix, cookie, handshake prefix, ...
await serveHost({ api, apiVersion, distDirs });
```

Nothing in the package names a product — every product string arrives through
`HostIdentity`, and `initHost` must run before anything else touches the
runtime (it also configures `@corbits/keychain`).

## Surface

- `initHost` / `hostIdentity` — product declaration and access.
- `serveHost` — the process skeleton: port, token door, hub mount, SPA, drain.
- `openDatabase`, `migrateHub`, `HUB_MIGRATIONS` — pglite + vendored schema.
- `mountHub`, `hub`, `hubWebSocket`, `SIDECAR_WS_PATH` — the embedded hub.
- `ensureHub`, `hubFetch`, `hubTransport`, `mintOwnerSetCookie` — embedded/remote client.
- `credentialBackend`, `storeSecret`, `readSecretResult` — secret storage.
- `hostStatus`, `startHeartbeat`, `clientConnected` — lifecycle.
- `HostError`, `ERROR_CODES` — the error surface routes share.

## Dependencies

`@corbits/embed-hub`, `@corbits/keychain`, `@intx/*` (vendored Interchange),
pglite, drizzle-orm, hono.
