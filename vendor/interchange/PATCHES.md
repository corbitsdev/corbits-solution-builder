# Vendored Interchange — local patches

Vendored from `faremeter/interchange` `origin/main` at the revision in
`VENDORED_REVISION`, which is ahead of the published 0.3.0 packages.

Every local change is listed here. Keep this file honest: an unlisted change is
a change nobody can find when the vendor is refreshed.

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

## `packages/hub-sessions/src/workflow-run-reader.ts`, `packages/hub-api/src/routes/workflows.ts` — HTTP route for run blobs

**Why.** Step outputs whose JSON exceeds the 1 MiB inline threshold spill to
`runs/<runId>/blobs/<sha256>` on the deployment's workflow-run repo
(`workflow-host/src/adapters/blob-substrate.ts`). The vendored hub has a route
for the run's event log (`GET /:runId/runs/:eventRunId/events`) but none to
fetch a spilled blob's bytes, so a hub client cannot read a large step output
at all.

**What changed.** `WorkflowRunReader` gains `readRunBlob(repoId, ref, runId,
sha)`, validating `sha` against the same 64-hex shape the workflow-run kind
handler enforces at push time and returning `null` when the repo, ref, run, or
blob is absent. `hub-api/src/routes/workflows.ts` adds
`GET /:runId/runs/:eventRunId/blobs/:sha`, guarded the same way as the events
route, returning the bytes as `application/octet-stream`, 404 when the reader
returns null, 400 when `sha` is malformed.

**Upstream-able.** Yes; it is a read-only addition alongside the existing
events route, following the same shape.

**Kill date.** 2026-10-16. Tracked as
[INTR-566](https://linear.app/abklabs/issue/INTR-566).

## `packages/workflow`, `packages/workflow-host`, `packages/agent`, `packages/inference` — per-call inference options on a step

**Why.** An agent step's model call is made by the runtime inside the run,
and nothing on that path could carry an output cap: an agent definition
holds only source preferences, a source resolved from a catalog offering has
no defaults, and the step invoker passed no per-call options, so every
specialist ran under the provider adapters' hard-coded 4096 output tokens.
A stage-4 design is a full HTML document that needs several times that, and
the person's own limit in Settings could not reach the call. The definition
is fixed at deploy time, so anything decided per run has to arrive with the
run, the way a step's `input` does.

**What changed.**

- `@intx/workflow`: `step({ inference: Selector })` — a selector resolved
  beside `input` against the run's trigger payload and step outputs. The
  runtime hands the resolved object to the invoker as
  `StepInvokeRequest.inferenceOptions`; `null`/`undefined` means the agent's
  defaults, anything but an object fails the step as a selector error. Only
  `maxTokens`, `temperature` and `thinking` may arrive this way
  (`StepInferenceOptions`): how much the call may spend and how it samples.
  A `systemPrompt`, `tools` or `providerOptions` in the resolved object
  fails the step — a run may not displace the definition that was approved
  at deploy time, which is the control the frozen definition exists to
  keep. Not recorded on `StepStarted`: it shapes the call, it is not what
  the agent was asked. `projectPrimitive` spreads the primitive, so the
  selector is part of the wire definition and its hash. Tests in
  `src/runtime/step-inference-options.test.ts`.
- `@intx/workflow-host`: the step invoker forwards them as
  `SendOptions.inference` on that send alone — the warm agent outlives the
  step, so they are never built into it.
- `@intx/agent`: `SendOptions.inference`, carried on the queued send to
  `reactor.deliver(message, { inference })`. The agent and reactor accept
  the full `InferenceOptions`: their callers are code with the agent in
  hand, not a run; the workflow step is where run-supplied values enter,
  and that is where the allowlist sits.
- `@intx/inference`: `Reactor.deliver` takes `DeliveryOptions`; the options
  are held for the message's run (`message.run.started` to
  `message.run.ended`) and merged beneath the director's own infer options
  for every inference in it, so a director that names an option outright
  still wins. A delivery that correlates to a parked gate opens no run and
  drops them.

**Upstream-able.** Yes, as-is: additive on every surface, no behaviour
change for a step that names no selector, and the test file is written to
land beside the runtime's other tests.

**Kill date.** 2026-10-16. Tracked as
[INTR-567](https://linear.app/abklabs/issue/INTR-567).

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

## `packages/hub-api/src/routes/workflow-definitions.ts`, `packages/types/src/workflows.ts`, `packages/hub-client/src/workflows.ts` — `POST /workflows/definitions`

**Why.** CL-8075: the host had no route to register a `workflow_definition`
row it generated itself (`registerDefinition` in `apps/hub/src/hub-gaps.ts`),
because the only path that creates one is `POST /workflows/deployments`,
which evaluates source on a probe sidecar. The lifecycle's own definition
(`workflow-seed.ts`) is keyed to a name the command ledger's session anchors
on before any deployment exists, so it still needs a direct register.

**What changed.** `createWorkflowDefinitionRoutes` gains `POST /`, gated by
`requireGrant("workflow-definition:*", "create")`. Identity is keyed on
`(tenantId, name, wireHash)`: an existing row whose wire hash matches is
returned unchanged (`created: false`); otherwise a row is inserted under a
caller-supplied or generated id. `@intx/types` gains `CreateWorkflowDefinition`
/ `CreateWorkflowDefinitionResponse`; `@intx/hub-client` gains
`registerWorkflowDefinition(transport, tenantId, input)`.

**Upstream-able.** Yes; it is a small addition alongside the existing
list/rollback routes, gated the same way.

**Kill date.** 2026-10-16. Tracked as
[INTR-569](https://linear.app/abklabs/issue/INTR-569).

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

## `packages/db/src/model-source-resolution.ts`, `packages/hub-sessions/src/workflow-allocation-service.ts` — ancestor credentials require `credential:<id>/use`

**Why.** CL-8133: a project tenant already sees its workspace catalog and
credentials by ancestry (`listVisibleOfferings` / `resolveCredentialById`,
the cl-8009 walk). `buildSource` then authorized those inherited
credentials by ownership alone, so a project's deploy could use every
workspace provider without the project principal holding
`credential:<id>/use`. Delegation grants minted into the child tenant
(or an ancestor) were never consulted on this path.

**What changed.** `listVisibleOfferings` still walks the ancestor chain;
catalog rows stay on the ancestor and are not copied into the project
tenant. `resolveSourcesByOfferingIds` takes an optional deploying
`principalId`. When supplied, a credential whose `tenantId` is not the
resolving tenant (inherited) additionally requires that principal to hold
`credential:<id>/use`, collected across the tenant ancestor chain
(`collectGrantsInChain`). A credential the resolving tenant owns itself
is unchanged. Omitting `principalId` keeps the prior ownership-only rule
so `resolveModelSources` callers are unaffected. The allocation service
passes `sourceAuthorityPrincipalId` at prepare and at allocation recover.
`credentialDelegationAllows` only consults credential-shaped grants
(`credential:<id>` and `credential:*`), so a child tenant's owner `*/*`
does not satisfy the check — that grant is what hub-api mints on every
new tenant, and without the filter default-deny never holds. Tests in
`packages/db/src/model-source-resolution.test.ts`.

**Upstream-able.** Yes; it is an additive optional argument on the deploy
resolution path, fail-closed for inherited credentials, and it reuses the
existing grant collection the credential walk already mirrors.

**Kill date.** 2026-10-16. Tracked as
[INTR-574](https://linear.app/abklabs/issue/INTR-574).
