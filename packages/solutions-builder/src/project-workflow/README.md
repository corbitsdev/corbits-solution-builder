# Loop-driven project workflow

CL-8721: the product's process authority. One `sb-project-<projectId>` workflow
deployed per project by the installer, holding REAL artifact references (never
their content), decided and read client-side.

## Topology

`workflow.ts` defines one manual-trigger workflow: `init` (action, builds the
initial carried state from the trigger payload) -> `rework` (the ONE `loop`)
-> `exhausted` (records cap exhaustion, never approval). The loop body is
`hold` (identity action, parks `trigger.payload` in a step output -- a body
resumed from its log loses `trigger.payload`, step outputs survive) ->
`wait: awaitSignal("project.decision")` -> `apply: action("applyDecision")`,
whose input is `merge([steps.hold.output, steps.wait.output])`. `while` and
`carry` (`projectWorkflowLoopWhile`/`Carry` in `loops.ts`) read/return the
`apply` step's output: `while` continues until `state.done`; `carry` threads
the whole new state forward as the next iteration's `trigger.payload`.

Beside `init`, before the loop, `name` (agent step, the kit's namer, no
tools, 60 s timeout) reads the trigger payload's `problemStatement` and
replies with a title; a failure routes to `nameFailed`, so it never fails the
run. The loop starts after `init`, `named` and `nameFailed`: one of the last
two is skipped, and a dependency on either alone would skip the loop (#203),
while a namer still running beside a parked loop kills the run (#201). A
decision is sent only once the run is parked (`waitForPark`), since a fresh
run's first park now waits on naming. Its model pin is `namer-source.js`,
written by the installer at deploy time.

500 `maxIterations` (see `workflow.ts`): headroom for a nine-stage project at
~50 decisions/stage (refusals, opens, send-backs, reapprovals).

## Carried state (v2)

`ProjectState` (`contracts.ts`): `projectId`, `stage`, `done`, `stageOrder`,
`reviews: Record<stage, ReviewState | undefined>`, `decisions` (append-only
ledger), `authorizedPrincipals`, `reviewCounts`.

The workflow never reads an artifact. Artifact versions are immutable and the
artifacts package computes `contentSha256` per version; a decision NAMES
`{ artifactId, version, sha256 }` and the reducer only ever records/compares
these references, never content.

## Decisions

Single signal name (`project.decision`), correlated by ids in the payload,
three kinds:

- `open_review { decisionId, projectId, stage, artifactId, version, sha256, at }`
  -- only for the CURRENT stage; opens (or replaces) the stage's review with a
  deterministic `stage-<n>-review-<count>` reviewId; a previous open review at
  that stage becomes `stale`.
- `approve { decisionId, projectId, stage, reviewId, artifactId, version, sha256, at }`
  -- must match the open review exactly (`stale_review` / `wrong_artifact` /
  `stale_version` / `hash_mismatch` otherwise); marks it approved, advances to
  the next stage (no review is auto-opened there); the last stage's approval
  sets `done`.
- `send_back { decisionId, projectId, stage, targetStage?, reason, at }` --
  `targetStage <= stage`, `reason` required; every review at stage >= target
  becomes `stale`, nothing deleted; omitted `targetStage` at the last stage
  defaults to the previous stage (delivery rejection).

Every refusal appends `{ accepted:false, reason }`; duplicate `decisionId` is
refused `duplicate`. `stageRules` (`contracts.ts`) is the seam for
per-stage approval rules: stage 5's stakeholder quorum, stage 6's Stack
section (the plan must carry a `## Stack` block citing minted requirement
ids, #55) and stage 7's cost/target freeze.

Principal comes ONLY from the hub-stamped top-level `principalId` on the
signal's output; a nested `principalId` on the decision payload is never read.
The reducer is deterministic: no clock, no randomness.

## Deployment

`packages/installer/src/project-workflow-deploy.ts`'s `ensureProjectWorkflow`
deploys one `sb-project-<projectId>` asset per project, pushes the compiled
package, deploys and triggers one manual run, reusing the live
deployment/run on later calls (mirrors `ensureSpecialistDeployment`'s
ensure-and-reuse discipline) -- as long as that run is on the code the
interface currently ships.

A change to this directory's code reaches existing projects too (#51). Every
run is triggered with the digest of the tree it was deployed from and a
generation number (`code` on the trigger payload, beside `projectId` and
`stages`; `initProjectState` ignores it), and both read back off the run's
own `RunStarted` event. When a live run's digest differs from the current
render, `ensureProjectWorkflow` deploys the current code at the next
generation, triggers it, and replays every decision the old run applied onto
it, in order and under the same ids, through the new reducer -- the same
path a host restart's dead deployment is revived by. A replayed decision the
new rules refuse is recorded by the reducer as any refusal is (a ledger row
with `accepted: false` and its reason) and returned to the client as
`replay.refused`, which the stage page shows. The hub has no way to end a
deployment, so the old run stays placed; readers prefer the newest generation
once it has caught up, and never signal the old one again.

The deployed package's `interchange.workflow`/`actions`/`loops` modules are
compiled from this directory's TypeScript (`workflow.ts`, `actions.ts`,
`loops.ts`) by `scripts/project-workflow-pack.ts` via `Bun.build`, not
hand-duplicated. `bun run ui:build` packs the compiled JS to
`apps/web/public/project-workflow/`, the same static-asset path the workflow
closure tarballs already use, so the browser-driven installer fetches
same-origin bytes rather than running a bundler client-side.

## Client

`apps/web/src/project-workflow.ts`'s `foldProjectWorkflow` is a pure fold over
recorded run events into a `ProjectWorkflowView`. `apps/web/src/client.ts`
adds `ensureProjectWorkflow`, `projectWorkflowView`, and `decide`.

## What is NOT done

The UI cutover (a later lane wires the fold into `apps/web/src/pages/**`).
