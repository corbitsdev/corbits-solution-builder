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
