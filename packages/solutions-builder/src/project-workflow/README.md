# Loop-driven project workflow (in-process proof)

CL-8718 phase 1: prove a project's review lifecycle can be driven by ONE
top-level native `loop`, in-process.

## Topology

`workflow.ts` defines one manual-trigger workflow: `init` (action, builds the
initial carried state from the trigger payload) -> `rework` (the ONE `loop`)
-> `exhausted` (records cap exhaustion, never approval). The loop body is
`wait: awaitSignal("project.decision")` -> `apply: action("applyDecision")`,
whose input is `merge([trigger.payload, steps.wait.output])` -- the carried
state and the signal's output, field-disjoint so no data is lost. `while` and
`carry` (`projectWorkflowLoopWhile`/`Carry` in `workflow.ts`) read/return the
`apply` step's output: `while` continues until `state.done`; `carry` threads
the whole new state forward as the next iteration's `trigger.payload`.

No hard `maxIterations` ceiling exists in the platform (`loop()` in
`vendor/interchange/packages/workflow/src/definition/primitives.ts:658-661`
only requires a positive integer). Chose 500: headroom for a nine-stage
project at ~50 decisions/stage (refusals, send-backs, reapprovals).

## Carried state

`ProjectState` (`contracts.ts`): `projectId`, `stage`, `done`,
`reviews: Record<stage, {reviewId, artifactId, version, sha256, status}>`,
`decisions` (append-only ledger), plus `authorizedPrincipals`, `stageOrder`,
`reviewCounts` -- static config and bookkeeping the reducer needs every
iteration, threaded on the same carry because a loop body's input is exactly
what `carry` returns.

## Refusals

`applyDecision` is a pure reducer; its only effect is the injected
`readArtifact`. Check order: shape (incl. top-level `principalId`, nested
`decision.principalId` never read) -> duplicate `decisionId` (state fully
unchanged) -> authority for the current stage -> `projectId` -> `stage` ->
`reviewId` -> `artifactId` -> `version` -> `readArtifact` + recomputed sha256
required to equal both the payload's and (if pinned) the review's ->
send-back's `targetStage` range. Every other refusal appends one
`{accepted:false, reason}` decision record; state is otherwise unchanged.

## What is proven

`scripts/project-workflow-proof-local.ts` runs approve -> six refusals
(unauthorized, stale review, stale version, hash mismatch, wrong project,
duplicate) -> send-back 2->1 -> the old stage-1 review refused -> reapprove
with the new review -> final approve -> `done`, asserting exactly one
`RunCompleted` and iterations == signals delivered.

## What is NOT proven yet

A deployed run, a host/process restart, real artifact reads (content is a
fixture map keyed by artifactId+version), specialists producing artifacts, or
any HTTP/hub signal-route stamping of `principalId`.
