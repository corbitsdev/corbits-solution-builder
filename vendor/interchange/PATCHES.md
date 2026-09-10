# Vendored Interchange — local patches

Vendored from `faremeter/interchange` `origin/main` at the revision in
`VENDORED_REVISION`, which is ahead of the published 0.3.0 packages.

Every local change is listed here. Keep this file honest: an unlisted change is
a change nobody can find when the vendor is refreshed.

## `packages/db/src/client.ts` — inject a database handle

**Why.** Upstream's `createDB` opens its own postgres.js socket, which requires
a running Postgres server. Solutions Builder is a local-first desktop app whose
recorded datastore is pglite (build plan §11) — embedded, with no socket. The
whole Interchange schema applies to pglite cleanly (all migrations apply; `bun run smoke:hub` proves it), so the only thing in the way was how the handle
is constructed.

**What changed.** `createDB` now also accepts `{ handle, close? }` and uses that
drizzle instance directly. Passing a config behaves exactly as before.

**Upstream-able.** Yes, as-is — it is dependency injection, not a behaviour
change, and it makes the package testable without a live server. Worth a PR.

## Removed from the vendor

`*.test.ts` files and nested `node_modules`, to keep the vendored tree small.
No source behaviour depends on them.

## `packages/hub-agent/package.json` — drop a devDependency that does not exist

**Why.** At `e2fa7e81` the package declares `"@intx/test-harness": "workspace:*"`
as a devDependency, and no package by that name exists in the tree — the
workspace is called `@intx/harness`. `bun install` cannot resolve it, so the
whole workspace fails to install.

**What changed.** That one line is removed. It is a devDependency of a package
whose tests we do not run; nothing at runtime references it.

**Upstream.** Worth reporting: either the dependency should name `@intx/harness`
or the package is missing from the published tree.

## `apps/sidecar` — vendored alongside the packages

**Why.** Interchange ships no sidecar binary in a package; `apps/sidecar` is
the canonical host process that runs hub-orchestrated workflows. The embedded
hub spawns it through a local-process provisioner, so it is vendored at the
same revision as the packages (`VENDORED_REVISION`), unmodified, minus build
artefacts. It runs from source, which is why the provisioner's runtime is
`apps/hub/bin/sidecar-runtime` (adds `--conditions intx-src`).

## `packages/hub-sessions/src/workflow-allocation-service.ts` — the deploy's default source is approved

**Why.** `pinInertStepSources` approval-gates every step, agent or not, and a
non-agent step falls back to the deploy's `defaultSource`. The approval set is
whatever the capability walk collected from agent declarations, so a workflow
with no agent step — pure orchestration of gates, signals and child workflows,
which is what a project lifecycle is — could never deploy: its default source
was never "approved" by anyone. The deploy request names the default source
explicitly and `resolveSourcesByOfferingIds` has just checked the deploying
authority against it, so treating it as an operator approval is the honest
reading.

**What changed.** `prepareProvisionedDeployment` adds
`inference.source:<provider>:<model>` for the default source to the approved
grant set it pins steps with and freezes into the bundle.

**Upstream-able.** Yes; it is an addition to the approval set with a stated
rationale, and it touches no other path.

## `apps/sidecar/bin/workflow-child`, `apps/sidecar/bin/workflow-probe-child` — no `intx-src` on the shebang

**Why.** The sidecar evaluates deployed workflow packages from a materialized
closure. A published `@intx/*` tarball carries the `intx-src` export condition
pointing at source it does not ship, so under that condition
`import "@intx/workflow/definition"` from a closure fails with "Cannot find
module". The sidecar and its children must therefore run without the
condition, which needs the vendored packages to have the `dist/` their
`default` export names: `bun run vendor:build` (`scripts/vendor-build.ts`)
emits it, and `apps/hub/bin/sidecar-runtime` no longer adds the condition.

**What changed.** The two shebangs are `#!/usr/bin/env bun`.

**Upstream-able.** No; upstream's dev loop deliberately runs from source and
its deployments run a bundle. This is the cost of vendoring source.

## `packages/workflow-host/src/workflow-definition-loader.ts` — the import failure names its cause

**Why.** The probe child ships only the error message; `{ cause }` never
reaches the hub, so a deploy failed with "failed to import interchange.workflow
entry" and nothing else.

**What changed.** The workflow-entry import error appends the cause's message.

**Upstream-able.** Yes.
