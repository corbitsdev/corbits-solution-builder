# Vendored Workbench packages

Three Corbits-authored, unpublished packages copied from
`corbitsdev/workbench` at the revision in `VENDORED_REVISION`, licensed
LGPL-2.1-or-later. They give the embedded hub a sidecar provisioner that
runs each allocation as a child process on this machine, which is what lets
Interchange's own `apps/sidecar` execute workflows for a desktop app.

| Package | Role |
| --- | --- |
| `@corbits/process-provisioner` | `SidecarProvisioner` that spawns a sidecar process per allocation |
| `@corbits/sandbox-sidecar` | Shared provisioner core: idempotence, generation fencing, destroy tombstones |
| `@corbits/error-sink` | Error reporting the two above depend on |

Local changes, all listed:

- `package.json` in each: `@intx/*` pinned versions became `workspace:*`
  (they resolve to the vendored Interchange tree); scripts and
  devDependencies dropped; `tsconfig.json` replaced with one extending the
  repo root.
- `process-provisioner/src/process-backend.ts`: the spawned sidecar receives
  `SIDECAR_CREDENTIAL_ENCRYPTION_KEY` from the hub process environment, which
  the hub sets from its keychain-held key.
