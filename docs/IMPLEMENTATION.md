# Implementation

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun 1.4 or newer |
| Host API | Hono on a random loopback port, session token in the launch URL |
| Database | pglite (embedded Postgres), drizzle-orm |
| Control plane | Interchange's hub app, vendored and mounted in process; the host calls its HTTP API |
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
compiled single-file host carries them. `bun run check:vendored-migrations`
fails when that file is behind the vendor.

## Host process

`apps/hub/src/server.ts` opens the database, applies Interchange's migrations then
the builder schema, mounts Interchange's hub app, and listens. Boot seeds
nothing. The host is a client of that hub: embedded, `hub-client.ts` dispatches
into the mounted Hono app; hosted (`SOLUTIONS_BUILDER_HUB_URL`), the same
calls go over HTTPS. Platform writes go through the hub API, not drizzle on
public tables.

The client installs the app over the host's `/hub` proxy. On launch it
asks `installState()` through `@solutions-builder/installer` (same-origin
credentials; the proxy attaches the owner session after `ensureOwner()`),
which recomputes "installed" every time by comparing the tenant's workflow
definitions against the hash the package would generate right now — there is
no stored version flag — and calls `install()` when anything is missing or
stale. The same `install()` runs on first launch, on upgrade, and after
every credential change, and is idempotent, doing, in order:

- the owner principal (minted by the host at boot) and the local tenant
  (created in-process at boot so the proxy never offers a root
  `POST /api/tenants`)
- the one workflow definition generated from the ledger, `project-lifecycle`
  — the row the command ledger's own session keys on
- the roles the ledger names, held by the owner
- project authority for every project tenant
- the curated kit's skills, installed as hub assets
- the provider catalog reranked at boot, so a model that can no longer
  answer drops behind the ones that can
- the per-project lifecycle deployment, once a provider is connected

Opening a project is two steps: the installer's `createProject` (child
tenant, authority, credential delegation) over `/hub`, then
`POST /api/projects/:projectId/open` for the ledger's `project.create`.

The `/hub` proxy only forwards installer and workflow routes. Git-token
and auth surfaces are refused, as is creating a root tenant. Hub
`Set-Cookie` is stripped so the browser never holds the owner session.

The provider list calls install again after any credential change so bindings
follow credentials.

It prints a launch URL carrying a session token. Every API request must present
that token. The hub proxy is guarded the same way; after that outer door it
calls `ensureOwner()` and forwards the owner session, so the browser does not
have to hold a second cookie.

`GET /api/status` includes `canPlaceSidecars` and `sidecarFingerprint` from
the embedded mount, so a client can tell whether this host can place a sidecar.

Closing the window does not stop the process. Only an explicit stop does.

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
| `check:vendored-migrations` | Fail when the host's migration list drifts from the vendored SQL |
| `typecheck` | `tsc --noEmit`, strict |
| `check` | The load-bearing gate: hub migrations, the ledger, boundaries, typecheck, and the specific smokes `package.json`'s `check` script names — in order, not every smoke below |
| `check:ledger` | The ledger is consistent and the generated workflows match it |
| `check:boundaries` | The one-direction rule |
| `check:slop`, `check:tokens`, `check:layout`, `check:markdown` | Interface audits |
| `check:ui` | `check:slop`, `check:tokens`, `check:layout` and `check:markdown` together — the static interface audits, all in the gate |
| `check:full` | `check` plus `smoke:responsive`. The only thing outside the default gate is the responsive smoke: it drives headless Chrome and is killed by the OOM reaper under load (observed: one of two isolated runs, at 70-90 load average on 8 cores). A gate that fails for reasons unrelated to the change teaches people to ignore it, so it is run deliberately rather than on every merge. |
| `smoke` | The nine-stage loop and every refusal path |
| `smoke:upgrade` | Migrations on an existing database |
| `smoke:db-lock` | Recovering from a crashed pglite lock, and refusing a second live writer |
| `smoke:launch` | Desktop launch paths (binds a fixed port; a run left over from a failed check must be killed before a retry) |
| `smoke:hub` | Embedded and hosted hub topologies |
| `smoke:sidecar` | The embedded hub's own sidecar, deploying the lifecycle as a real workflow |
| `smoke:sidecar-delegation` | A project tenant cannot use a workspace offering until the owner delegates that credential, and a revoke fails the next resolve |
| `smoke:conversation`, `smoke:guidance` | Stage conversation and the product guide |
| `smoke:material` | Source material attached to a project reaches the specialists |
| `smoke:stakeholders` | Stakeholders changed while a project is under way |
| `smoke:choices` | What counts as a specialist's offered choice, in prose |
| `smoke:deck` | The stakeholder deck: an outline parsed and rendered to slides |
| `smoke:design` | Stage-4 anchored feedback |
| `smoke:kit` | Specialist definitions |
| `smoke:catalog` | Provider catalog rows |
| `smoke:agent` | Drafts through a real provider; skips cleanly without one |
| `smoke:failure` | Provider failure classification and remediation |
| `smoke:oauth` | OAuth lifecycle against the real issuers |
| `smoke:transfer` | A project exported and re-imported round-trips exactly |
| `smoke:responsive` | Layout at narrow widths |
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
