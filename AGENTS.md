# Working in this repository

## Verify before asserting

`bun run check` is the gate: shard and migration consistency, dependency
boundaries, typecheck, unit tests, the interface build and the static
interface audits. Run it before claiming anything works.
Green does not mean the product is right - drive the app for anything a person
would see.

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

No script enforces these today; review does. If you need to break one, say so
and why, rather than routing around it.

- **One state machine.** A project's `ProjectState` (stage, reviews,
  decisions, freeze, requirements, stakeholder votes) is written only by its
  project workflow (`packages/solutions-builder/src/project-workflow/`):
  `initProjectState` builds the first state, and `applyDecision` in
  `project-workflow/contracts.ts`, the reducer the workflow's `apply` step
  runs, produces every later one. That reducer and its `stageRules` are the
  authority on a transition; a decision it refuses is never applied, and a
  client that checks one of its rules first only explains it. The client
  alone gates three things today: stage 6's Stack check before the plan is
  approved, stage 8's requirement that a build archive be published before a
  review opens, and stage 9's final approval, sent only after the delivery
  tool call is approved. The project record (title, stakeholder policy,
  archive and delete marks) is not `ProjectState` and is written through the
  installer (`packages/installer/src/project-tenant.ts`); a stage 5 review
  captures the stakeholder policy into `ProjectState` when it opens.
  `packages/solutions-builder/src/ledger.ts` names the stages, authorities and
  transition rows that the installer's roles and authority grants and the
  client's stakeholder roles read; it enforces nothing.
- **The app package depends on nothing in the apps.** `packages/solutions-builder/src/`
  imports only the workflow authoring surface and the platform's types.
- **Only the host runtime touches a provider** or an agent runtime:
  `packages/embedded-host` (the process skeleton a product composes — paths,
  pglite, keychain secrets, vendored hub migrations, the hub mount, the serve
  loop) plus `packages/embed-hub` are the only importers of Interchange
  internals. `apps/hub/src` is the product composition: identity, routes, and
  the `serveHost` call.
- **The client never writes persistence.** No database, schema or command-dispatch import
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
