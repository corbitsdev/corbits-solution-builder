# Vendored Interchange — local patches

Vendored from `faremeter/interchange` `origin/main` at the revision in
`VENDORED_REVISION`, which is the v0.4.0 tag (`5453d0b`).

Every local change is listed here. Keep this file honest: an unlisted change is
a change nobody can find when the vendor is refreshed.

## `packages/workflow/src/runtime/env.ts`, `runtime/run.ts`, `packages/workflow-host/src/child/run-child.ts`, `supervisor/supervisor.ts`, `ipc/control-channel.ts` — wake dispatch on author-signal parks

**Why.** Issue #150: a top-level loop can durably park its container on a
`signal-relay` await, but the supervisor only learned about `input` and
`approval` parks. Its terminal-or-park dispatch wait then sat until the 300 s
backstop, leaving the triggering mail reclaimable after the run had consumed it.

**What changed.** The production child sends a run-scoped `run.parked` control
frame after the runtime flushes an author-signal park. The supervisor advances
the run's park generation and wakes its waiter without registering a hub
correlation. IPC, child emission, and long-lived dispatch tests cover the path.

**Upstream-able.** Yes; the frame and wakeup behavior belong in Interchange's
workflow host.

**2026-09-21 refresh (`79adc433` → `5453d0b`, v0.4.0).** No local patch
dropped. The range was checked file-by-file: `packages/db/src/client.ts`
is untouched upstream, so no pglite-handle equivalent landed and the
`{ handle, close? }` injection stays; the version bump (`5453d0b`
"Update interchange version to v0.4.0", 0.3.0 → 0.4.0 across package
manifests) touches no patched file. Three patched files did move
upstream, all without hunk overlap — re-applied verbatim:
`packages/workflow/src/definition/primitives.ts` (doc comments on
`AwaitSignalPrimitive` / `ChildWorkflowPrimitive` / loop), `runtime/env.ts`
(new required `hasUpstreamSignalResolver`), `runtime/run.ts`
(`bridgeAbort` consolidation). New upstream migration
`0093_sidecar_initialization.sql` is carried in `hub-migrations.ts`.

**2026-09-18 refresh (`e2fa7e81` → `79adc433`).** Three local patches dropped
because upstream now provides the same fix natively:

- `packages/hub-agent/package.json` — the stray `@intx/test-harness`
  devDependency is gone from upstream's own `package.json`.
- `packages/workflow-deploy/src/orchestrator.ts` — Brian Fox's
  `pin-non-agent-top-level-steps-as-placeholders` landed: a non-agent leaf
  step now pins `config.defaultSource` as an inert placeholder with no
  approval check, superseding both this patch and the grant-set patch below.
- `packages/hub-sessions/src/hub-session-lookups.ts` — upstream's own
  INTR-548 fix landed (an unconditional `createIfAbsent` mint ahead of the
  ownership guard), a different shape than ours but the same behavior. The
  regression test `hub-session-lookups.terminal-guard.test.ts` is kept; it
  exercises the real guard and still passes against upstream's version.

The `workflow-allocation-service.ts` "deploy's default source is approved"
patch is also dropped: it existed only to cover the gap the orchestrator fix
above now closes at the pin itself, so the grant-set workaround is now dead
weight.

**2026-09-18 caller audit (CL-8552).** Every remaining entry was checked
against a caller in `apps/hub/src`, `packages/*`, `apps/web/src`, `scripts/`
(a lot of host code — `agent-conversation.ts`, session-turn writing, host
inference, command-dispatch — was deleted the same day). One patch had none:

- `packages/hub-api/src/routes/sessions.ts`, `packages/hub-api/src/app.ts`
  — its only callers, `apps/hub/src/hub-gaps.ts` and the command ledger's
  `engine-ledger.ts`, are both gone. Reverted to upstream; row dropped.
- `packages/workflow-deploy/src/capability-walk.ts` ("per-step grants for
  leaf steps inside loop bodies") — [INTR-545](https://linear.app/abklabs/issue/INTR-545)
  is Done, and its PR (`faremeter/interchange#190`) merged as
  `79adc43350a535e808439f05b71ec70aa00490a0` — our own `VENDORED_REVISION`,
  so the fix is an ancestor (the same commit). Reverted `capability-walk.ts`
  to upstream's file entirely. Upstream's shape is different from ours — a
  canonical `walkNestedWorkflowSteps` that still folds a loop body's grants
  into its node's single `perStep` entry, not a separate entry per leaf step
  id — and our own regression suite (kept at revert time, run against
  upstream's file) caught the gap: 5 of 26 assertions in
  `capability-walk.test.ts` failed (no `perStep` entry for a loop-body leaf
  id, no collision throw), so the test file was deleted too rather than kept
  green by accident. **This is a live regression risk**: a loop-body agent
  leaf may still hit `credentialsSnapshot has no entry for stepId` at deploy
  time under vanilla upstream. Gate results below confirm whether
  `test:vendored`/`smoke:hub` reach that path; if they do not, the gap needs
  its own INTR issue and possibly a re-add of this patch under a fresh
  problem statement.

Every other entry still has a live caller. `git ls-remote
https://github.com/faremeter/interchange.git HEAD` returns `79adc433` —
upstream `main` has not moved since the previous refresh, so none of them
have a newer upstream equivalent to drop in favor of yet. Each carries a
kill date and an upstream ask, filed in the `Interchange` Linear team
(`INTR-*`), linked below.

## `packages/hub-sessions/src/session-service.ts` — pack a source asset at its pinned commit

**Why.** Solution Builder #246 follow-up (a stage 5 specialist "could not be
started"): `deployWorkflowFromSource` pins a source-asset deploy to
`source.package.commitSha` and verifies that commit exists, but
`bindAssetAttachmentResolver` then packed the asset's default ref (`main`)
fresh at closure-delivery time. The deploy pack carries only the packed
commit and its tree, and the sidecar reads the closure's subtree at the
pin — so when a second push moved `main` between the deployer's push and
the pack (two windows deploying the same stage specialist three seconds
apart, identical trees), the pin was not in the pack and the sidecar
failed with `git subtree … could not be read at <pin>: Could not find
<pin>`.

**What changed.** A source arm's resolver resolves and packs `commitSha`
itself (isomorphic-git's `resolveRef` accepts an object id); the mount still
names `refs/heads/main` as its ref. A tarball arm has no pin and packs the
default ref as before. The install probe rebinds the same resolver, so the
probe and the deploy pack the same commit.

**Upstream-able.** Yes; the pin the hub already verifies should be the
commit it ships.

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

**Kill date.** 2026-10-16. Tracked as
[INTR-564](https://linear.app/abklabs/issue/INTR-564).

## Removed from the vendor

`*.test.ts` files and nested `node_modules`, to keep the vendored tree small.
No source behaviour depends on them.

## `apps/sidecar` — vendored alongside the packages

**Why.** Interchange ships no sidecar binary in a package; `apps/sidecar` is
the canonical host process that runs hub-orchestrated workflows. The embedded
hub spawns it through a local-process provisioner, so it is vendored at the
same revision as the packages (`VENDORED_REVISION`), unmodified, minus build
artefacts. It runs from source, which is why the provisioner's runtime is
`apps/hub/bin/sidecar-runtime` (adds `--conditions intx-src`).

**Kill date.** N/A — this is vendoring scope, not a behaviour delta; it stays
as long as we vendor Interchange source at all. No INTR issue (nothing to ask
upstream to change).

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

**Kill date.** N/A — same as `apps/sidecar` above; no INTR issue.

## `packages/workflow-host/src/workflow-definition-loader.ts` — the import failure names its cause

**Why.** The probe child ships only the error message; `{ cause }` never
reaches the hub, so a deploy failed with "failed to import interchange.workflow
entry" and nothing else.

**What changed.** The workflow-entry import error appends the cause's message.

**Upstream-able.** Yes.

**Kill date.** 2026-10-16. Tracked as
[INTR-565](https://linear.app/abklabs/issue/INTR-565).

## `packages/workflow/src/runtime/commit-chain.ts` and `packages/workflow-host/src/adapters/repo-store.ts` — a flush another writer overtook is re-folded, not failed

**Why.** A container run's log gains a `SignalReceived` twice for one delivered
signal: once from the awaiter and once from the relay that carries it into the
loop body. When the body's round finishes within a second (a round that asks
for no draft, such as a stage's submit or an alignment step), the batch that
carries the iteration's `ChildCompleted` has had its seqs assigned before the
second record lands, and the store refuses it: `seq conflict on append …
single-writer invariant violated`. The loop step fails, the runtime routes on
to the stage's gates, and the lifecycle run is wedged until it is deployed
again. Seen on every fast round in a session, at stages 5, 6 and 7.

**What changed.** `repo-store.ts` carries the conflict on the error it throws
(`seqConflict: { expected, supplied }`). `commit-chain.ts`'s `flushBuffer`
catches that one failure, reads the durable log again, validates each pending
transition against it, renumbers the batch to continue from the tip, and
appends once more, up to three times. A duplicate `SignalReceived` is a no-op
to the reducer, so what lands is what would have landed.

**Upstream-able.** The retry is defensive and local; the two writers are the
real question for upstream — which of the awaiter and the relay should own the
record when both see the same delivery.

**Kill date.** 2026-10-16. Tracked as
[INTR-568](https://linear.app/abklabs/issue/INTR-568).

## `packages/hub-api/src/routes/assets.ts` — `POST /:assetId/tree`, `GET /:assetId/blob`

**Why.** CL-8075: the hub creates a `workflow` (and `skill`) asset over HTTP
but offered no route to write its source tree or read a blob back short of
git smart-HTTP, so the host called `assetService.populateAsset` /
`readAssetBlob` in-process (`writeWorkflowSourceTree` / `readWorkflowSourceBlob`
in `hub-gaps.ts`).

**What changed.** Two routes beside the existing tarball PUT/GET pair, gated
the same way (`requireGrant(idResource("asset", "assetId"), "write"|"read")`
on the session's own grant, no git bearer token required — the tarball PUT
route is the precedent: the `hubPrincipal` constant is reused for the write
so the kind handler's `validatePush` still runs). `POST /:assetId/tree`
commits the given repo-relative files onto the asset's ref (default
`refs/heads/main`) in one commit and returns the commit sha; a rejection from
the kind handler surfaces as 400. `GET /:assetId/blob?path=&ref=` returns
`{ content }` -- the bytes at that path, base64-encoded inside a JSON
envelope rather than as a raw octet-stream body, so a caller with only the
`Transport` interface (JSON-only `fetch`, no raw body access -- this is what
`@solutions-builder/installer` gets, since it may not import the host's own
`hubApi`) can read it too, not only the host's direct-fetch clients. 404 when
the asset, ref or path is absent.

**Upstream-able.** Yes; additive, and it gives every asset kind a JSON write
path the tarball routes only gave `package-registry`.

**Kill date.** 2026-10-16. Tracked as
[INTR-571](https://linear.app/abklabs/issue/INTR-571).

## `packages/hub-api/src/routes/workflows.ts`, `packages/hub-api/src/app.ts` — `POST /:runId/signals` named-signal grant and principal stamp

**Why.** CL-8089: the route required `workflow-run:<id>/manage` for every signal, so a
principal granted only a named signal on that run could not deliver it. The
payload also accepted a caller-supplied `principalId`, which a client could
use to impersonate another actor.

**What changed.** After the body is validated, the route authorizes
`signal:<signalName>` on `workflow-run:<runId>`, or `manage` on the same
resource. A missing grant is 403. The delivered payload's `principalId` is
always the authenticated caller; a client-supplied value (top-level or on
the payload object) is overwritten. Tests in `routes/workflows.test.ts`:
403 without the grant, named `signal:<name>` allows that signal only, and
a spoofed `principalId` is replaced.

**Upstream-able.** Yes; it is a narrower grant on the existing run resource
plus a server-side identity stamp, and it preserves `manage` as a
superset.

**Kill date.** 2026-10-16. Tracked as
[INTR-573](https://linear.app/abklabs/issue/INTR-573).

## `packages/types/src/catalog.ts`, `packages/db/src/schema/catalog.ts` — operator-registered provider plugins

**Why.** The catalog restricted `model_provider.plugin` to the four built-in
adapter keys, so a provider served by an adapter the sidecar loads from
`SIDECAR_ADAPTER_MANIFEST` could not be recorded. ChatGPT (Codex) speaks
only the Responses API; as `openai-compatible` it 404s on
`/chat/completions`.

**What changed.** `ModelProviderPlugin` is any non-empty string
(`modelProviderPlugins` still lists the built-ins); the Drizzle enum on
`modelProvider.plugin` is dropped (the SQL column was always plain `text`,
no migration). An unregistered key fails at deploy admission. Tests in
`packages/types/src/catalog.test.ts`, `packages/db/src/parse-row.test.ts`.

**Upstream-able.** Yes; identical to `faremeter/interchange` commit
`50cc0177` on branch
`intr-583-allow-operator-registered-custom-model-provider-types-in-the`.

**Kill date.** 2026-10-16. Tracked as
INTR-583.

## `@intx/inference@0.4.0` (npm, not vendored) — default output cap 4096 → 32000

**Why.** #45: a stage specialist's step names no output cap, so every call
goes out with its adapter's default `max_tokens: 4096`. On `claude-sonnet-5`
adaptive thinking counts against that cap, and a turn that reasons past it
ends with a thinking block and no text: no reply mail, the run never parks,
and the stage sits on "Working on it…" until the supervisor's backstop. The
proper fix is a per-step cap, which needs `faremeter/interchange#194`
(per-call inference options), still open and unreleased. Vendoring
`@intx/agent` and `@intx/inference` to carry it was judged too large for the
size of the problem.

**What changed.** A `bun patch` (`patches/@intx%2Finference@0.4.0.patch`,
wired through `patchedDependencies` in the root `package.json`) changes the
fallback cap in the two adapters that hardcode one: `options.maxTokens ?? 4096`
becomes `?? 32000` in `dist/providers/anthropic.js` and
`dist/providers/openai.js` (which also serves `openai-compatible`: xAI, the
xAI OAuth proxy, OpenRouter, OpenCode Zen, local endpoints). An explicit
`maxTokens` still wins. `google-genai` and `openai-responses` (Codex) send no
cap unless one is set and are not touched.

**Where it takes effect.** The request is built by the adapters of the
sidecar's own installed `@intx/inference`: the workflow child builds its
adapter registry from it (`apps/sidecar/src/workflow-substrate-factory.ts`,
`loadAdapterRegistry`) and hands it to every step agent. The copy packed into
a deployment's closure is loaded but never builds a request. So the patch
applies after `bun install` once the host's sidecar processes are restarted,
to already-deployed specialists as well, and a checkout installed before the
patch keeps 4096 whatever it deploys.

**Known cost.** A model whose own output limit is below 32000 now refuses an
uncapped call instead of answering at 4096. Among the seeded models that is
OpenAI's `gpt-4o` and `gpt-4o-mini` (16,384) and `gpt-4-turbo` (4,096), which
return HTTP 400 on `max_completion_tokens` above their limit; they remain
selectable, though none is the default. The same applies to an
OpenAI-compatible server whose context or output limit is below 32000. No
seeded Anthropic model allows less than 64,000.

**Upstream-able.** No — upstream's answer is `#194`, not a larger default.

**Removal.** When an `@intx/inference` release includes `#194`, bump the
dependency, set per-role caps on the specialist step, and drop the patch file,
the `patchedDependencies` entry and this section.

**Kill date.** When `faremeter/interchange#194` is released; tracked as #45.

## `@intx/inference@0.4.0` (npm, not vendored) — adapter-classified responses

**Why.** ChatGPT's Codex backend answers `/codex/responses` with an SSE stream
and no `Content-Type`. The harness checks the header before any adapter sees
the response, so every Codex call failed with "Cannot detect response kind:
response has no Content-Type header". `@corbits/codex-provider`'s own
`withCodexContentTypeRepair` wraps `fetch`, but the sidecar builds its
inference dependencies from the global `fetch` with no hook to replace it.

**What changed.** The same `bun patch` adds `faremeter/interchange#198`'s
harness half, without its tests or capture tooling: `ProviderAdapter` gains an
optional `classifyResponse(headers)`, consulted only when `detectResponseKind`
rejects a 2xx; `undefined` keeps the protocol-mismatch error.
`packages/embed-hub/src/responses-adapter.ts` wraps
`createOpenAIResponsesAdapter` and classifies as SSE for sources whose quirks
path is `CODEX_RESPONSES_PATH`; the sidecar adapter manifest points at it.

**Upstream-able.** Yes — it is `faremeter/interchange#198` (INTR-601).

**Removal.** When an `@intx/inference` release includes `#198`, bump the
dependency, move `classifyResponse` into `@corbits/codex-provider`'s adapter,
and drop this hunk of the patch, `responses-adapter.ts` and this section.

**Kill date.** When `faremeter/interchange#198` is released.
