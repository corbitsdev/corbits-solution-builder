# using-interchange

`@intx/*` is on npm — latest tag 0.4.0. A generated app installs the
versioned packages from the registry, never vendors source:

    bun add @intx/workflow@0.4.0
    bun add @intx/agent@0.4.0

Vendoring upstream main (`git clone
https://github.com/faremeter/interchange vendor/interchange`, pin in
`vendor/interchange/VENDORED_REVISION`, `vendor/interchange/packages/*`
in `workspaces`) is this repository's own flow for tracking main between
tags. It applies to Builder's own workspace, not to a workspace being
built.

A workflow is a definition built from steps — `defineWorkflow` from
`@intx/workflow`:

    import { defineWorkflow, step, action, awaitSignal } from "@intx/workflow";

    export default defineWorkflow({
      id: "draft-report",
      triggers: [{ type: "manual" }],
      steps: {
        draft: step({ agent: draftingAgent }),
        review: awaitSignal({ name: "human-review", after: ["draft"] }),
        publish: action({ handler: "publish-report", after: ["review"] }),
      },
    });

Steps order by `after`. A `step({ agent })` runs an agent; an `action` names
a handler the package declares in `interchange.actions`; `awaitSignal` parks
the run on a human. The rest of the vocabulary: `loop`, `map`, `gate`,
`childWorkflow`, `sleep`, `onTrigger`, `escalation`. Test a definition in
memory with `@intx/workflow/runlocal`.

Other surfaces: `createAgent` and `defineDirector` from `@intx/agent`; tool
runners in `@intx/tools-posix`, `@intx/tools-mail`, `@intx/tools-lsp`;
`@intx/hub-client` is a client's handle to a running hub.

A hub deploy names a source: an npm registry, or a hub asset — a checked-out
git repo holding the definition at a pinned commit. Package the deliverable
so a deploy can name it.
