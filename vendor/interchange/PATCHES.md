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
rationale, and it touches no other path. Superseded in spirit by the
placeholder pin below; kept until that lands so a refresh cannot undeploy
orchestration-only workflows.

## `packages/workflow-deploy/src/orchestrator.ts` — non-agent top-level steps pin as placeholders

**Why.** The same gap as above, at the pin rather than the grant set. Nested
onTrigger bodies already pin a non-agent step to the deploy default with no
approval check (`buildReferencedWorkflowSourcePins`). Top-level leaves still
went through `pickStepInferenceSource`, which requires an `inference.source:`
grant agents never advertised. Brian Fox's unmerged branch
`origin/pin-non-agent-top-level-steps-as-placeholders` (`2ee2af74`) gives the
top-level pin the same rule.

**What changed.** `buildInertProjectionStepSources` skips the picker for
`!isAgent` leaves and pins `config.defaultSource` as an inert placeholder.
Agent steps keep the resolver and the operator-approval gate. Fail closed when
the config carries no default source. This is Brian's hunk only; the rest of
the vendored tree is untouched.

**Upstream-able.** Yes — it is his commit, waiting on `faremeter/interchange`
main. Drop this patch (and the grant-set one above) when that lands and the
vendored revision is refreshed.

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

## `packages/hub-sessions/src/hub-session-lookups.ts` — missing terminal-event run rows are minted, not misread as foreign

**Why.** Upstream INTR-548: loop-iteration terminal events
(`<anchor>__revise-N__M`) were ERROR-ignored as "does not belong to source
deployment". The creation side is correct — the composite id is stamped at
`step-scope.ts` `loopBodyRunId` — but no `workflow_run` row ever exists for
these children: `onPark` fires only for reserved-channel suspends, never a
plain author-named `awaitSignal` gate (pinned by `park-notify.test.ts`), so
the correlation-register path that lazily mints internal rows never runs.
The lookup guard (`ownedRun?.anchorRunId !== anchor.id`) then conflated a
missing row (`undefined`) with a row anchored to another deployment, and
returned before the graceful missing-row handling ten lines below.

**What changed.** The guard is split: a missing row is `createIfAbsent`-minted
as an internal run (`anchorRunId` of the deployment, the deployment's
`definitionId`/`tenantId`, `principalId: null`, `running` — the same row the
register path would have written) so the terminal flip below has somewhere to
land; only a row that exists with a genuinely different `anchorRunId` keeps
the loud ERROR ignore. The anchor lookup now also selects `tenantId` and
`definitionId` to populate the minted row. Regression tests in
`hub-session-lookups.terminal-guard.test.ts` drive the real
`receiveWorkflowRunPack` with a scripted executor: missing → one mint insert
plus the terminal flip; foreign → no insert, no flip.

**Upstream-able.** Yes, as-is: the missing case keeps the register path's row
shape, the foreign case is byte-for-byte the old behaviour, and the test file
is written to land beside the guard.

## `packages/workflow-deploy/src/capability-walk.ts` — per-step grants for leaf steps inside loop bodies

**Why.** Upstream INTR-545: a tool call from a step nested in a loop body is
refused before the implementation runs. The capability walk builds its
per-step grant map keyed only by top-level step order; a loop body's nested
steps fold into the loop node's single entry, so there is no entry for a leaf
step id inside the body. At run time the child's authorize looks the invoking
step id up in the frozen snapshot built from this map and throws
(`credentialsSnapshot has no entry for stepId`). The unmerged proof branch
`cl-8012-live-proof` carries the acceptance criteria: its stub answers the
stage-5 specialist with a genuine tool-call delta and inspects the sidecar's
own tool result, and those assertions fail until this walk emits the leaf
entries.

**What changed.** After the top-level walk records a loop node's folded union
(the required approval set is unchanged; the gate now also sees the per-leaf
rows below), it emits one entry per leaf step id inside the loop body through
the same single dispatch, frozen with the same deployment-wide trigger
grants — recursing into loops nested in the body, whose leaves likewise
authorize under their own ids. A body leaf sharing a bare id with a
top-level step or another loop's leaf throws unless the grant sets are
identical (mirroring `pinInertStepSources`); the recursion dispatch is
exhaustive over primitive kinds, so a future body-bearing kind fails the
build rather than silently skipping its leaves. Tests in
`src/capability-walk.test.ts`: a loop-body agent leaf and its action sibling
each resolve under their bare body ids carrying exactly their own grants,
the leaves of a loop nested in a loop body resolve at every level, colliding
leaf ids (against a top-level step, and across sibling loops) throw, and an
identical repeat merges silently.

**Upstream-able.** Yes — this is the upstream PR for INTR-545, collision
policy included. Drop this patch when the vendored revision refreshes past
the upstream fix.

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

## `packages/hub-api/src/routes/tenants.ts` — `GET /api/tenants?parentId=`

**Why.** CL-8075: the host listed a project's child tenants by reading the
`tenant` table directly (`listChildTenants` in `hub-gaps.ts`), because
`GET /api/me/principals` lists the caller's own memberships, not the tenants
under a given parent.

**What changed.** `createTenantRoutes` gains `GET /`, requiring `?parentId=`
and membership in that parent tenant, returning every tenant whose
`parent_id` matches it, oldest first. Unpaginated, matching the asset list
route's own bare-array shape (the workspace's project count does not
approach page territory).

**Upstream-able.** Yes; it fills the same gap `POST /` already implies
(`parentId` is an accepted create field with no matching list).

## `packages/hub-api/src/routes/sessions.ts` (new), `packages/hub-api/src/app.ts` — `POST /sessions`, `POST/GET /sessions/:id/turns`

**Why.** CL-8075: `GET /api/me/sessions` is a stub returning `[]`, and no
route created an `agent_session` with a caller-chosen id, or wrote/read the
`session_mail` / `inference_turn` / `turn_part` rows a conversation turn is
made of. The command ledger (`engine-ledger.ts`) keys its per-project session
to the seeded lifecycle definition so it can record commands without an
offering or a sidecar, and reads its own history back the same way; both
went through direct table access (`ensureAgentSession`,
`writeConversationTurn`, `listConversationTurns` in `hub-gaps.ts`).

**What changed.** A new route group at `/api/tenants/:tenantId/sessions`:
`POST /` finds-or-creates an `agent_session` by caller-chosen id (idempotent
on id); `POST /:sessionId/turns` writes the mail record the platform expects
(built and signed the same way `hub-gaps.ts` did — via the injected
`principalKeyStore`) plus the `inference_turn`/`turn_part` pair, sequentially
rather than in one transaction (a shared single-writer connection may already
be inside another caller's transaction); `GET /:sessionId/turns` reads every
part on the session back, oldest turn first. Gated by an `agent-session:*`
grant, matching the naming convention of every other tenant-scoped resource.

**Upstream-able.** Yes; it is additive, and it is the natural home for the
turn-taking primitive `/api/me/sessions` is deferred pending.

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
the kind handler surfaces as 400. `GET /:assetId/blob?path=&ref=` returns the
raw bytes at that path, 404 when the asset, ref or path is absent.

**Upstream-able.** Yes; additive, and it gives every asset kind a JSON write
path the tarball routes only gave `package-registry`.

## `packages/hub-api/src/routes/workflows.ts`, `packages/hub-client/src/workflows.ts` — the deployment listing carries its provisioner binding

**Why.** CL-8075: `GET /workflows/deployments` projected an allocation's
status but not the provisioner binding it is pinned to, so a deployment
bound to another hub address could not be told apart from a reachable one
without a direct `sidecar_allocation` read (`allocationBinding` in
`hub-gaps.ts`).

**What changed.** The deployment list query also selects
`sidecar_allocation.provisioner_binding_fingerprint`, and
`WorkflowDeploymentResponse` (both the route's and `@intx/hub-client`'s) gains
an optional `provisionerBindingFingerprint`. `apps/hub/src/workflow-deploy.ts`
now reads it off the deployment it already fetched rather than making a
second call.

**Upstream-able.** Yes; it is one more field on an existing projection.
