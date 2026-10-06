# Working in this repository

## Verify before asserting

`bun run check` is the gate: `check:static` (typecheck plus the unit tests)
and `check:build` (the interface build). Run it before claiming anything
works.
Green does not mean the product is right - drive the app for anything a person
would see.

- `bun run dev` runs the host from source and opens the app; `bun run dev:stop`
  stops every host, watcher and sidecar, from any checkout.
- `bun run walk:browser` walks all nine stages in a real browser against a
  local model; see `scripts/WALK-BROWSER.md`.
- `bun test <path>` runs one test file.
- `bun run vendor:build` rebuilds the vendored packages after a pin refresh;
  install runs it.

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

- **One state machine.** A project's `ProjectState` is written only by its
  project workflow: `initProjectState` builds the first state, and
  `applyDecision` in `project-workflow/contracts.ts` produces every later one.
  A decision that reducer refuses is never applied; a client that checks one
  of its rules first only explains it. What the client gates alone, and what
  lives outside `ProjectState`, is in
  `packages/solutions-builder/src/project-workflow/README.md`.
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

## Working alongside other agents

Several agents work this repository at once, each in its own worktree. The
following still costs someone an evening when forgotten:

- Never `git stash`. Worktrees share one stash stack, so a stash in one
  worktree can swallow another's uncommitted work. Commit a WIP instead.
- Two `bun run check` runs at once can fail each other. `oauth-mount.test.ts`
  starts a real Codex login, which holds the fixed callback port 1455 until
  its test process exits. A 502 from that test while another gate, a dev
  host's Codex sign-in or the Codex CLI is running is that collision, not a
  defect; rerun once the other finishes.
- After resolving a merge or rebase, check `git status` before committing and
  run the gate on the committed tree. A gate run against the working tree
  proves nothing about what was pushed.
- Never `git checkout --ours <file>` when both sides changed it: that takes the
  whole file, not the hunk, and silently drops the other side's work.

## Conventions

- Commits follow Conventional Commits: `<type>(<scope>): <description>`.
  Branch as Linear names it (`cl-<n>-<slug>`), otherwise
  `<type>/<short-description>`. Never add a `Co-Authored-By` trailer or any
  other attribution to a commit, PR or issue. The rest is in CONTRIBUTING.md;
  a pull request that does not follow it is declined.
- One issue per defect, one PR per issue.
- Only leave comments when you are describing WHY we chose to do something,
  not how something works. Code should self-document easily enough.
