# Implementation

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun 1.4 or newer |
| Host API | Hono on a random loopback port, session token in the launch URL |
| Database | pglite (embedded Postgres), drizzle-orm |
| Control plane | Interchange, vendored, mounted in process |
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

The hub's migrations are copied into `src/host/hub/migrations.generated.ts` so
the compiled single-file host carries them. `bun run check:hub-migrations`
fails when that file is behind the vendor.

## Host process

`src/host/server.ts` opens the database, applies Interchange's migrations then
the builder schema, mounts the hub, seeds the workspace, and listens. On first
launch it seeds:

- the specialist kit as versioned records
- the compatibility matrix
- the workflow definitions generated from the ledger: `project-lifecycle`,
  one per stage, `approval`, `design-feedback`, `provider-switch`,
  `build-supervision`, `delivery`
- the roles the ledger names, held by the owner, with every agent bound to
  `specialist`
- each specialist's prompt as a commit in the hub's git registry

It prints a launch URL carrying a session token. Every API request must present
that token. The hub proxy is guarded the same way.

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
| `SOLUTIONS_BUILDER_HOST_COMMAND` | Debug builds of the shell only: run the host with this command instead of the bundled sidecar |
| `SOLUTIONS_BUILDER_DEV_RELOAD` | Mount `/api/dev/reload`, a change stream the development bundle subscribes to |
| `CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY` | Interchange's at-rest keys; minted into the keychain when unset |

## Credentials

Secrets go to the OS keychain through `security(1)` on macOS. Where no keychain
is available the host falls back to a file with `0600` permissions in the data
directory and reports that it did. What lands in the database is a reference
such as `keychain:provider:anthropic`, never the material. One function reads a
secret back, on the path to an outbound request.

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
| `desktop:build` | `.app` and `.dmg`, unsigned |
| `sidecar:build` | Compile the host to one self-contained binary |
| `generate:hub-migrations`, `check:hub-migrations` | Copy the vendor's migrations into the host; fail when stale |
| `typecheck` | `tsc --noEmit`, strict |
| `check` | Everything below, in order |
| `check:ledger` | The ledger is consistent and the generated workflows match it |
| `check:boundaries` | The one-direction rule |
| `check:slop`, `check:tokens`, `check:layout`, `check:markdown` | Interface audits |
| `smoke` | The nine-stage loop and every refusal path |
| `smoke:upgrade` | Migrations on an existing database |
| `smoke:launch` | Desktop launch paths |
| `smoke:design` | Stage-4 anchored feedback |
| `smoke:oauth` | OAuth lifecycle against the real issuers |
| `smoke:failure` | Provider failure classification and remediation |
| `smoke:hub` | Embedded and hosted hub topologies |
| `smoke:workflows` | Generated workflow definitions |
| `smoke:kit` | Specialist definitions |
| `smoke:conversation`, `smoke:guidance` | Stage conversation and the product guide |
| `smoke:responsive` | Layout at narrow widths |
| `smoke:catalog` | Provider catalog rows |
| `smoke:executor` | The in-process workflow runtime |
| `smoke:agent` | Drafts through a real provider; skips cleanly without one |
| `seed:demo` | A project with a decision waiting |
| `walk` | Render every screen with fixtures for review |

## Build

`desktop:build` runs `ui:build` and `sidecar:build`, then bundles the compiled
host as an external binary with `dist/` as a resource. The shell resolves the
interface from `SOLUTIONS_BUILDER_DIST_DIR`, then a `dist/` beside the
executable, then the repository's own, in that order.
