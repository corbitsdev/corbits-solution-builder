# Implementation

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun 1.4 or newer |
| Host API | Hono on a random loopback port, session token in the launch URL |
| Database | pglite (embedded Postgres), drizzle-orm |
| Control plane | Interchange's hub app, vendored; mounted in process when embedded, HTTPS when `SOLUTIONS_BUILDER_HUB_URL` is set |
| Interface | React 19, Vite, bundled fonts, no remote assets |
| Desktop shell | Tauri 2, macOS 13 or newer, tray presence |
| Types at the boundary | ArkType |
| Providers | `@corbits/oauth-core`, `@corbits/openai-responses`, `@corbits/xai-provider`, `@corbits/codex-provider` |
| Documents | `@corbits/artifacts` on the host's drizzle handle |

## Vendored Interchange

`vendor/interchange/` is a copy of the Interchange workspace at the revision
recorded in `vendor/interchange/VENDORED_REVISION`. Its packages are workspace
members and are imported as `@intx/*`.

Interchange is licensed under the GNU Lesser General Public License v2.1. The
vendored tree keeps that license. Every local change is listed in
`vendor/interchange/PATCHES.md`; an unlisted change is one nobody can find when
the vendor is refreshed.

The vendored packages export their source under the `intx-src` condition and
ship no `dist`. Every command that runs the host passes
`--conditions intx-src`. Without it the hub cannot be resolved and the host
exits before the handshake.

The hub's migrations are text-imported by `apps/hub/src/hub-migrations.ts` so the
compiled single-file host carries them. Keep that list in step with the
vendored directory when refreshing the pin.

## Host process

`apps/hub/src/server.ts` opens the database, applies Interchange's migrations then
the builder schema, mounts Interchange's hub app when the hub is embedded, and
listens. Boot seeds nothing: no tenant, no principal, no workflow definition.
The host is a client of that hub. Embedded, `hub-client.ts` dispatches into the
mounted Hono app; hosted (`SOLUTIONS_BUILDER_HUB_URL`), the same calls go over
HTTPS. Platform writes go through the hub API, not drizzle on public tables.

Identity is the hub's. A person signs up (or is invited) through the hub's auth
routes. A user principal is minted then; nothing else creates one. The signed-in
principal creates the workspace tenant (`POST /api/tenants`). The client
installs the app over the host's `/hub` mount as that principal. On launch it
asks `installState()` through `@solutions-builder/installer` (same-origin
credentials; the mount forwards the browser's own cookies), which recomputes
"installed" every time by comparing the tenant's workflow definitions against
the hash the package would generate right now — there is no stored version flag
— and calls `install()` when anything is missing or stale. The same `install()`
runs on first launch, on upgrade, and after every credential change, and is
idempotent, doing, in order:

- the workspace tenant, created by the signed-in principal if it does not
  already resolve by slug
- the one workflow definition generated from the ledger, `project-lifecycle`
  — the row the command ledger's own session keys on
- the roles the ledger names, held by that principal
- project authority for every project tenant
- the curated kit's skills, installed as hub assets
- the tool packages the lifecycle imports, shipped as workspace members of
  the workflow asset (or named from a registry asset when the hub is remote)
- the provider catalog reranked at boot, so a model that can no longer
  answer drops behind the ones that can
- the per-project lifecycle deployment, once a provider is connected

Opening a project is two steps: the installer's `createProject` (child
tenant, authority, credential delegation) over `/hub`, then
`POST /api/projects/:projectId/open` for the ledger's `project.create`.

The `/hub` mount is a same-origin prefix strip onto the hub app
(`hub-proxy.ts`). The desktop handshake is the process door. After that,
Interchange authz is policy: auth, root tenant create, git-tokens, and
catalog are not host-refused. Hub `Set-Cookie` is forwarded so the browser
holds a hub session. The mount does not attach a host session, strip
cookies, or impersonate a principal.

The connected provider list is read from the hub catalog over `/hub`, not
from a host provider-domain GET. Connect, OAuth loopback, order, refresh
and disconnect still go through the host. The list calls install again
after any credential change so bindings follow credentials.

It prints a launch URL carrying a session token. Every API request must present
that token. The hub mount is guarded the same way; after that outer door it
forwards the browser's own cookies.

`GET /api/status` includes `hub.mode` (`embedded` or `remote`),
`canPlaceSidecars` and `sidecarFingerprint` from the embedded mount, so a
client can tell whether this host can place a sidecar and whether the
lifecycle's packages will be embedded locally or resolved from a source the
remote hub names.

Closing the window does not stop the process. Only an explicit stop does.

## Embedded packages versus remote

A desktop embed cannot assume npm. `scripts/embed-workflow-closure.ts`
snapshots the vendored `@intx/*` `dist/` trees, `@solutions-builder/app`,
`@solutions-builder/tools-deck` and `@solutions-builder/tools-delivery` into
`packages/installer/src/workflow-closure-embed.ts`. `install()` reads that
snapshot and writes the files into the workflow asset as workspace members.
The sidecar resolves `workspace:*` from the same git pack. The web bundle
has no `node:fs`; the snapshot is what makes client-driven install possible
on the embedded hub.

A remote hub names a source instead: an npm registry, or a hub asset of
packed tarballs (`scripts/pack-registry-asset.ts`) or a source tree at a
pinned commit. Closure, pinning and integrity stay the platform's. Hosted
`install()` does not embed those trees in the browser bundle.

## Paths and environment

Data lives in one directory:

| Platform | Default |
|---|---|
| macOS | `~/Library/Application Support/SolutionsBuilder` |
| Windows | `%APPDATA%\SolutionsBuilder` |
| Linux | `$XDG_DATA_HOME/SolutionsBuilder` or `~/.local/share/SolutionsBuilder` |

The database is in `pglite/` under it. Build workspaces are in `builds/<run>`.

| Variable | Effect |
|---|---|
| `SOLUTIONS_BUILDER_DATA_DIR` | Override the data directory |
| `SOLUTIONS_BUILDER_DIST_DIR` | Where the host serves the interface from; otherwise a `dist/` beside the executable, then the repo's |
| `SOLUTIONS_BUILDER_HOST_COMMAND` | Debug builds of the shell only: run the host with this command instead of the bundled sidecar (the host compiled to one binary by `sidecar:build`) |
| `SOLUTIONS_BUILDER_HUB_URL` | Hosted Interchange hub. Absent, the hub is embedded in this process |
| `SOLUTIONS_BUILDER_DEV_RELOAD` | Mount `/api/dev/reload`, a change stream the development bundle subscribes to |
| `CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY` | Interchange's at-rest keys; minted into the keychain when unset |

## Credentials

Secrets go to the OS keychain through `security(1)` on macOS. Where no keychain
is available the host falls back to a file with `0600` permissions in the data
directory and reports that it did. The host keeps a keychain copy for its own
reads. Interchange's credential row seals the key with the hub's credential
encryption key (also in the keychain), so the sidecar receives the real bearer
rather than a `keychain:` reference. Plaintext never lands in a log, a
response, or an unencrypted column. One function reads a
secret back, on the path to an outbound host request.

An API key is validated against the provider's own model listing before it is
stored. That connection becomes Interchange's catalog: a `provider`, a
`credential` pointing at it, a `model_provider` naming the adapter and base URL,
one `model` per model served, and a `model_offering` with priority and the
capabilities the curated catalog records for it.

OAuth sign-in uses PKCE over a loopback redirect. Tokens live in the keychain.

## Scripts

| Script | What it does |
|---|---|
| `dev` | The host from source, hot-reloading, opens a browser |
| `host` | The host alone; prints the launch URL |
| `ui:build`, `ui:watch` | Build the interface |
| `dev:desktop` | Tauri window with the host running from source |
| `dev:fresh` | `dev:desktop` on a new empty data directory |
| `desktop:build` | `.app` and `.dmg`; signed and notarised when the Apple env vars are set, unsigned otherwise (see "Releasing the desktop app") |
| `sidecar:build` | Compile the host to one self-contained binary |
| `typecheck` | `tsc --noEmit`, strict |
| `check` | The gate: typecheck, unit tests (ours and the vendored ones we rely on) and `check:build` |
| `check:build` | `ui:build`, so a change that breaks the interface build fails the gate |
| `seed:demo` | A project with a decision waiting |
| `walk` | Render every screen with fixtures for review |
| `vendor:build` | Emit `dist/` for the vendored packages, which the sidecar needs since it runs without `intx-src`; runs on `bun install` |
| `postinstall` | `vendor:build`, so a fresh `bun install` leaves `dist/` in place without a separate step |

## Build

`desktop:build` runs `ui:build` and `sidecar:build`, then bundles the compiled
host as an external binary with `dist/` as a resource. The shell resolves the
interface from `SOLUTIONS_BUILDER_DIST_DIR`, then a `dist/` beside the
executable, then the repository's own, in that order.

## Releasing the desktop app

`desktop:build` is `scripts/desktop-release.ts`, a wrapper around
`tauri build`. It reads Apple's own env contract for macOS signing and
notarisation — `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an
app-specific password), `APPLE_TEAM_ID` — which `tauri-cli` reads directly;
the script never puts them on a command line. When all four are set it
signs and notarises, then verifies with `codesign --verify --deep --strict`,
`spctl -a -vv`, and `xcrun stapler validate` before calling anything
notarised. When any is missing it builds unsigned instead.

Either way it writes `release/RELEASE.md` and `release/SHA256SUMS`: artefact
names, sizes, SHA-256, a signing status of `signed-and-notarised`,
`signed-not-notarised`, or `unsigned` with the reason, Tauri and Bun
versions, and the git sha. The honesty rule: a status of
`signed-and-notarised` is only ever written after every verification command
above has exited 0 — a missing variable or a failed verification is recorded
as such, never silently upgraded.

`--target universal-apple-darwin` passes through to `tauri build` for a
universal binary. `desktop:build:dry` (`--dry-run`) prints the plan —
signed or unsigned, and why — without building.
