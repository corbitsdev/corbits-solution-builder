# @corbits/embed-hub

Embeds an Interchange hub in-process: binds a pglite handle, composes
`createApp`/`createAuth` and the process provisioner, mounts the mailbox,
artifacts, and provider OAuth login, and returns a `MountedHub` the host
serves like any other Hono app.

```ts
import { createEmbeddedHub } from "@corbits/embed-hub";

const hub = await createEmbeddedHub({
  pglite, credentialKeyHex, principalKeyHex, signingKey,
  dataDir, hubWebSocketUrl, sidecarEntry, sidecarRuntime,
  callbackPageCopy,   // OAuth callback page copy — the mounting product's
  notificationSender, // local-part of <sender>@<tenant>.local inbox rows
});
app.route("/", hub.app);
```

## Surface

- `createEmbeddedHub` / `CreateEmbeddedHubOptions` / `MountedHub` — the
  composition entry and its handle (`app`, `db`, `auth`, `assetService`).
- `SIDECAR_WS_PATH` — the path a provisioned sidecar's WebSocket dials.
- `./pg-compat` — a leaf result-shape adapter with no `@intx/*` imports,
  safe for callers that must not touch platform internals.

## Dependencies

Vendored `@intx/*` internals plus the `@corbits/*` provider/mailbox/artifacts
packages the embedded composition mounts.
