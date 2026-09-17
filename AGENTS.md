# Working in this repository

## Verify before asserting

`bun run check` is the gate: ledger consistency, dependency boundaries,
typecheck, the nine-stage loop smoke, and the sidecar smoke that deploys the
lifecycle as a real workflow through the process provisioner. Run it before
claiming anything works.
Green does not mean the product is right - drive the app for anything a person
would see.

Every in-process smoke imports `scripts/smoke-env.ts` first, which gives the
run a data directory of its own when `SOLUTIONS_BUILDER_DATA_DIR` is unset.
Without it a smoke reads the developer's own settings and writes build
workspaces, decks and hub data into the developer's own workspace. A new smoke
starts the same way.

## How this sits on Interchange

Read this before proposing any change to how the platform is used. Most wrong
turns here start with one of these being assumed rather than checked.

- **`vendor/interchange` is upstream, unmodified, at the revision in
  `VENDORED_REVISION`.** Its packages are bun workspace members, so `apps/hub`
  imports `@intx/db` and gets the vendored copy. There is no separate install
  step and no npm dependency on the platform.
- **Refreshing the pin is routine. Editing a vendored file is not.** Every local
  edit is listed in `vendor/interchange/PATCHES.md` with its reason and whether
  it can go upstream. Adding another is a cost to argue for, not a default. If
  upstream already fixed it, refresh the pin instead.
- **We author `apps/*` and `packages/*`.** Upstream's own apps are reference
  examples, not something to vendor and adapt.
- **The hub deploys code, and the platform decides where the bytes come from.**
  A deploy names a source: an external npm registry, or a hub asset - a
  checked-out git repo - holding the definition either as packed tarballs or as
  a source tree at a pinned commit. Dependency-closure resolution, version
  pinning and integrity are the platform's, identical across those sources.
- **Search the vendored tree before proposing to build a mechanism.** Registry
  and asset-backed package resolution, offline closure resolution, capability
  approval and workflow provisioning are already there. Reinventing one is the
  most expensive mistake available in this repository.
- **Read a handler through, and follow the types down, before concluding a
  capability is missing.** A guard in one route is not an absent subsystem; the
  layer beneath it may already do the work.

## The rules the code keeps

These are enforced by `scripts/check-ledger.ts` and `scripts/check-boundaries.ts`.
If you need to break one, the honest move is to change the checker deliberately
and say why, not to route around it.

- **One state machine.** `packages/solutions-builder/src/ledger.ts` is the contract.
  `packages/solutions-builder/src/guard.ts` is the only place it is enforced. The
  workflow definition in the app package (`packages/solutions-builder/src/workflows/`,
  `admit.ts`) is the only place a run's state is written.
- **The app package depends on nothing in the apps.** `packages/solutions-builder/src/`
  imports only the workflow authoring surface and the platform's types.
- **Only `apps/hub/src/` touches a provider** or an agent runtime, and only its
  platform files (`hub-*.ts`, `db.ts`, `schema.ts`, `migrate.ts`) import
  Interchange internals.
- **The client never writes persistence.** No database, schema or engine import
  in `apps/web/`.

## Honesty rules that are product requirements, not style

- A control that does not exist is **absent**, never simulated. The bounded build
  bridge reports final text and an exit status; it does not synthesise events,
  sessions, steering or checkpoints from stdout.
- An unknown is not a pass. A process exiting zero is not evidence.
- Secrets never reach a response body, a log, an artifact or a prompt. The UI
  sees a status and a boolean.
- No cloud fallback when a local endpoint is unavailable. Unavailable is a state.
- An approval names exact versions and their hashes.

## Conventions

- Commit messages and how to open a PR: see CONTRIBUTING.md. These rules bind
  humans and agents alike; a pull request that does not follow them is declined.
- One issue per defect, one PR per issue.
- Comments explain why, not what. The code says what.
