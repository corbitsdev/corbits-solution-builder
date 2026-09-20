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
refused `duplicate`. `stageRules` (`contracts.ts`) is the seam for later
per-stage approval rules (stage 5 quorum, stage 7 cost freeze); none are
registered yet.

Principal comes ONLY from the hub-stamped top-level `principalId` on the
signal's output; a nested `principalId` on the decision payload is never read.
The reducer is deterministic: no clock, no randomness.

## Deployment

`packages/installer/src/project-workflow-deploy.ts`'s `ensureProjectWorkflow`
deploys one `sb-project-<projectId>` asset per project, pushes the compiled
package, deploys and triggers one manual run, reusing the live
deployment/run on later calls (mirrors `ensureSpecialistDeployment`'s
ensure-and-reuse discipline).

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

The UI cutover (a later lane wires the fold into `apps/web/src/pages/**`) and
registering any `stageRules`.
