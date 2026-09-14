`@intx/*` packages are on npm: `bun add @intx/workflow`. The newest tag
is 0.3.0; upstream is github.com/faremeter/interchange and its main runs
ahead of the tag. When the plan needs what only main has, vendor it:

    git clone https://github.com/faremeter/interchange vendor/interchange
    git -C vendor/interchange rev-parse HEAD > vendor/interchange/VENDORED_REVISION
    bun install

`vendor/interchange/packages/*` is already in this workspace's
`workspaces`, so the vendored packages resolve as `@intx/*` the moment
the tree lands. The revision file is the pin.

The surfaces a deliverable builds against:

- `@intx/workflow` — `defineWorkflow` and the step vocabulary:
  `step({ agent })`, `action`, `loop`, `map`, `gate`, `awaitSignal`,
  `childWorkflow`, `sleep`, `onTrigger`, `escalation`, plus the run
  state machine. `@intx/workflow/runlocal` drives tests in memory.
- `@intx/workflow-host` — the production runtime env: persistence,
  scheduling, the signal channel.
- `@intx/workflow-deploy` — deploy-time validation, the capability walk
  that computes the grants a workflow requires, and operator-approval
  gating.
- `@intx/agent` — `createAgent` for a single agent; `defineDirector`
  shapes its behaviour.
- `@intx/tools-posix`, `@intx/tools-mail`, `@intx/tools-lsp` — the tool
  runners an agent step calls; `@intx/tool-packaging` is their package
  format and loader.
- `@intx/hub-client` — a client's handle to a running hub.
- `@intx/hub-sessions`, `@intx/hub-agent` — session orchestration and the
  sidecar-to-hub link.
- `@intx/authz`, `@intx/db`, `@intx/types` — grants, persistence and the
  contracts everything shares.

A workflow package declares its composition in package.json:
`interchange.workflow` is the definition entry; `interchange.directors`,
`interchange.loops`, `interchange.actions` and `interchange.tools` name
the modules its own extensions come from. A package with no such fields
composes to the built-ins.

A hub deploy names a source: an npm registry, or a hub asset — a
checked-out git repo holding the definition as packed tarballs or as a
source tree at a pinned commit. Package the deliverable so a deploy can
name it: published packages, or a git repo at a pinned commit.
