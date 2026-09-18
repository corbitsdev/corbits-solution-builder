# 8270 — Native Interchange gates

Hard cutover of stage approvals to the platform's own primitives. The host's
second approvals machine (`/submit`, `/decide`, `submitAndApprove`, the
host-built `run` + `context` the gate signal carried, `abortBuildAttempt`) is
deleted. What replaces each piece is something Interchange already has.

| Ours (deleted)                                        | Platform primitive                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST /projects/:id/submit`, `/decide`, `/commands/<gate>` | `wait` step + named signal; client calls `deliverWorkflowSignal` over `/hub` |
| `submitAndApprove` (submit then approve on the host)  | two signals from the client, in order, each on its own gate                    |
| `context.actorAuthorities` in the signal body         | `signal:<name>` grant on `workflow-run:*` for the principal; hub 403s without it |
| `idempotencyKey` / `expectedRevision` in the body     | caller-supplied stable `signalId`; runtime dedups on `observedSignalIds`, 409s on a reused id with a different payload |
| `abortBuildAttempt` (host worker map, HTTP-driven)    | `build.cancel`/`build.interrupt` are named signals on the run (the build is a sidecar tool since #300; there is no host worker) |
| `admitGate` validating host-assembled `run`/`context` | `admitGate` as a guard: the gate's stage and kind are workflow literals (`merge` + `literal` selectors), the person's intent is thin, authority is the grant that let the signal in |
| `alignRunWithLedger` (host walks the run to the ledger with owner-principal signals) | the run is the state machine; the ledger follows it (write-on-read `recordAdmittedGates`) |

## Files touched

apps/hub/src
- `api-decisions.ts` — delete `/submit`, `/decide`; `/commands/:command` 404s for every gate command (a person's decision on a run); keep it for host-effect commands only (`build.freeze`, `build.start_attempt`, `build.answer`, `stage.select_route`, `stage.retry`, `build.resume`, `project.archive`, `project.delete`). Drop `abortBuildAttempt`.
- `command-dispatch.ts` — delete `submitAndApprove`, the `runGateSideEffects` call, the host-built `run`/`context` payload and the `GATE_COMMANDS` branch. A gate command reaches `execute` only from the host's own paths (a worker that could not run fails its attempt as `system`).
- `gate-delivery.ts` — reduced to the `stage.draft` round relay (the host still assembles inference for a draft). `GATE_COMMANDS`, `RunBefore`, alignment: deleted.
- `lifecycle-run.ts` — delete `alignRunWithLedger`, `alignOnce`, `parkedPosition`, `consumed`, `REPLACEMENTS`, `FIRST_PARK_WAIT_MS`, `SETTLE_MS`, `LIVENESS_CHECK_MS`. Keep `deliverStageSignal` for rounds and `projectExecutionStatus` (write-on-read).
- `command-ledger.ts` — `ledgerEntryFromGateSignal` reads the thin intent: stage from the signal name (`positionOfSignal`), post-state from the ledger row, actor from the hub-stamped `principalId`, idempotency = `signalId`. No `run`/`context`/`idempotencyKey`/`correlationId`/`actorPrincipalId` body reads. `build.cancel`/`build.interrupt` join the recorded gate set.
- `projects.ts` — `projectDetail` syncs the ledger from the run (`projectExecutionStatus`) before reading runs/approvals, so a client signal shows up on the next GET.
- `domain.ts` — delete the gate body validators (`StageApprovePayload`, `SoloDecidePayload`, `AudienceDecidePayload`, `CostApprovePayload`, `RoutePayload`, `DeliveryDecisionPayload`).
- `api.ts` — `commandFrom` no longer reads `idempotencyKey` from the body; `expectedRevision` stays for host effects only.
- tests: `gate-delivery.test.ts` (rewritten), `command-ledger-gate.test.ts` (thin intent), `project-detail-standing.test.ts`, new `api-decisions.test.ts`.

packages/solutions-builder/src
- `admit.ts` — `admitGate(input)` where input = signal payload ⊕ workflow literals `{ stage, gate }` ⊕ carried tally. Builds the `RunView` from the literals, not from the client. Authority = delivery (the hub already authorized `signal:<name>`); `actorAuthorities`, `run`, `context`, `events` are not read. Stage 5 audience tally is carried across gate iterations; `audience.decide` records and keeps the gate open.
- `guard.ts` — export `authoritiesFor(command)` (the row's authority set) and a `recorded` refusal code (an audience decision was taken; the gate stays open); `GuardContext.actorAuthorities` stays for host-effect commands.
- `workflows/stage-loop.ts` — `gateIteration`/`evidenceGate` admit input becomes `merge([wait output, literal { stage, gate }, trigger.payload])`; delete `alignmentStep`, `AlignmentStep`, `LedgerPosition`.
- `workflows/lifecycle-source.ts` — same admit input in the rendered source; stage-5 quorum rendered as a literal.
- tests: `admit.test.ts`, `workflows/stage-loop.test.ts`.

packages/installer/src — `workflow-deploy.ts` `carryGate` carries the admit output (unchanged shape); tests adjusted where the rendered text changed. `signal-grants.ts` is already the authority and is unchanged.

apps/web/src
- `client.ts` — delete `submit`, `decide`; `command` stays for host-effect commands; `CommandOutcome` loses `delivery` on gate paths.
- `run-signal.ts` — `gateSignalName(stage, command, standing)`, `signalIdFor(intent)` (SHA-256 of tenant, anchor, signal name and intent → the same click is the same signal), `deliverGate(detail, standing, intent)`, `decideStage` (submit, wait for the gate to park, approve).
- `app.tsx`, `pages/workspace/index.tsx`, `pages/audiences.tsx` — every gate button delivers a signal; `expectedRevision`/`idempotencyKey` gone from decision bodies. `build.freeze` stays a host effect (it writes the packet): the run left gate 7 on `cost.approve`, so the freeze has no gate of its own to signal.
- tests: `run-signal.test.ts` (dedup, stage-9 mapping, cancel, no client authority fields).

scripts — `lib/stage-walk.ts` and `transfer-smoke.ts` deliver signals instead of `execute`/`runGateSideEffects` for gate commands.

## Ordered steps

1. Plan (this file), own commit.
2. `admit.ts` + `stage-loop.ts` + `lifecycle-source.ts`: workflow literals into the admit input; thin-intent admit; delete alignment helpers. Tests 3, 4, 6.
3. `command-ledger.ts`: thin-intent ledger entry; cancel/interrupt recorded. Test updates.
4. Hub routes: delete `/submit`, `/decide`, `submitAndApprove`, gate commands on `/commands`, gate-delivery/alignment, `abortBuildAttempt`; worker follows the run; `projectDetail` write-on-read. Tests 1, 5 (hub side).
5. Web: signal helpers and button rewiring; delete `submit`/`decide`. Tests 2, 4, 6 (client side).
6. Scripts and installer test fixes; typecheck + test green for `apps/hub`, `apps/web`, `packages/*`.
7. PR to `internal-beta`.

## Non-goals

- Stage 8 host effects: `/build/start` (spawns the bounded bridge worker), `/build/accept` (packages the archive, records the manifest), `build.fail` after a worker ended, and `build.start_attempt` stay host commands. The sidecar's build agent step is not driven by this change.
- `build.freeze` keeps its host effect (writing the frozen packet artifact). Gate 7 is crossed by `cost.approve`; the freeze is not a gate on the run.
- `stage.draft` rounds keep the host relay: the host assembles `inference` (provider credentials) and delivers the round; that is not an approval.
- Route-back inside the workflow (a rejected stage re-entering an earlier one): the lifecycle stays linear; `stage.select_route` is ledger-only as before.
- Regenerating `workflow-closure-embed.ts`. It is stale and its check is not fixed here.
- A new host read endpoint. Authority is not read back from the host; the hub enforces it at delivery.

## Risks

- Per-command authority is coarser than per-signal authority: `signal:<name>` is per gate, and one gate accepts several commands (stage 5's `stage.approve` and `audience.decide`; stage 7's `cost.approve` and `stage.reject`). A principal granted the gate signal can send any of that gate's commands. The installer already mints the grant for every role on any of those commands, so this is the platform's granularity, not a regression from the host guard's per-row check on hub-derived roles. Follow-up: per-command signal names.
- Ledger lag: the ledger follows the run on read. A GET immediately after a signal may run before the runtime commits `SignalReceived`; the client folds the run itself and treats hub state as truth.
- Deleting alignment means a run that fell behind a legacy ledger is no longer walked forward. Legacy projects show where the run stands, not where the ledger says.
- The vendored hub's `DELETE /runs/:runId` (stop a run, release its allocation) is `501 not_implemented` (INTR-454). Cancel therefore lands as a signal the run records. The allocation itself cannot be released from this repo until the platform ships that route.
- Two-step solo approve is two signals with two ids; a crash between them leaves the stage submitted, which is where a plain submit leaves it.

## Acceptance criteria

1. Cancel is a decision on the run, not a host worker map. `build.cancel` from the client is a named signal on the run (`roundSignal(8)`) over `/hub`, recorded on the ledger by write-on-read as the run's `cancelled` landing. No `abortBuildAttempt`, no host cancel dispatch, no host build path (deleted on `internal-beta` in #300). Releasing the allocation itself is the hub's `DELETE /runs/:id`, `501 not_implemented` in the vendored hub (INTR-454). — `apps/web/src/run-signal.test.ts`, `apps/hub/src/command-ledger-gate.test.ts`, `apps/hub/src/gate-delivery.test.ts`.
2. Duplicate `signalId` is deduped; a decide double-click is a no-op. `signalIdFor` is deterministic for the same intent, so the second click posts the same `signalId`; the runtime's `observedSignalIds` dedup takes it, and the ledger receipt skips a second turn. — `apps/web/src/run-signal.test.ts`, `apps/hub/src/command-ledger-gate.test.ts`.
3. A stale revision / already-decided gate is refused by the runtime, not by body fields. `admitGate` refuses (`wrong_state`) an intent whose `runId`/stage disagree with the gate's literals; `expectedRevision` in the body is not read anywhere on the path. — `packages/solutions-builder/src/admit.test.ts`, `apps/hub/src/api-decisions.test.ts`.
4. The stage-9 (final) gate maps to its named signal: `delivery.accept`/`reject`/`revise` at stage 9 → `solutions-builder.stage.9.approve`; `delivery_recipient` holds that grant. — `packages/solutions-builder/src/workflows/stage-loop.test.ts`, `packages/installer/src/signal-grants.test.ts`, `apps/web/src/run-signal.test.ts`.
5. A principal without `signal:<name>` is refused by the hub. The vendored route authorizes `signal:<signalName>` (else `manage`) and 403s (`workflows.test.ts` "delivers a named signal when the caller holds only signal:<name>", `signal:other` → 403); the `/hub` mount forwards the browser's cookies without swapping in the owner session, so the client is that principal. — `apps/hub/src/gate-delivery.test.ts` (mount + route assertions), vendored `workflows.test.ts` via `test:vendored`.
6. Authority derives from hub grants, not client-sent context. `admitGate` does not read `actorAuthorities`, `context`, or `run`; the web intent builder never sends them; the ledger entry's actor is the hub-stamped `principalId`. — `packages/solutions-builder/src/admit.test.ts`, `apps/web/src/run-signal.test.ts`, `apps/hub/src/command-ledger-gate.test.ts`.
