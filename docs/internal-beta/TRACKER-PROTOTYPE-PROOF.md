> **Superseded (2026-09-20):** this document describes an approach that was superseded when the native project workflow shipped as one top-level loop in `packages/solutions-builder/src/project-workflow`. Authenticating specialist output turned out not to be required — mail is authenticated at ingress. See `packages/solutions-builder/src/project-workflow/README.md`. Kept below unchanged for historical record.

# Native tracker prototype proof

Baseline: Solution Builder `f96eb557bb7409c700c06364c7b44fcc3bdf6692` with vendored Interchange `79adc43350a535e808439f05b71ec70aa00490a0`.

Upstream was refreshed during the investigation. `faremeter/interchange` at `bca283b734a972e87a5d12ad36673d55baa80aec` is 16 commits ahead. The changed production files concern test seams, timeout scheduling, and reconnect diagnostics/configuration; the workflow action, signal, and composition surfaces used here are unchanged.

## Checkpoint result: not passed

This is a partial proof, not a production topology selection. The deployed test
uses a synthetic review/hash to isolate native signal/action/restart behavior;
the exact-content SHA-256 validation tests run locally. No independent stage
specialist was activated by this tracker. Stop before production migration.

## Investigated bounded topology

The intended composition keeps conversational specialists as independent single-step deployments. The local tracker prototype is a separate deterministic workflow containing only top-level `awaitSignal`, `action`, and `gate` primitives. The deployed reproducer isolates top-level waits and actions. Both avoid `childWorkflow`, `loop`, and `onTrigger`; neither proves independent specialist coordination.

A review pins project, stage, review identity, artifact identity/version, SHA-256 of real content, producer deployment identity, producer definition hash, and authorized principals. A decision repeats those identities plus an idempotency identifier and the platform-stamped `principalId`. Validation recomputes the content hash and rejects unauthorized, wrong-project, out-of-order, stale-review, stale-version, wrong-artifact, and hash-mismatch inputs.

The first problem-review signal is followed by a separate retry signal. A stale input is durably consumed and rejected, then the workflow parks on the retry rather than losing its only review opportunity. This is a bounded reproducer, not a production strategy for arbitrary send-back.

## Evidence obtained

- Nine focused contract/definition tests pass with `bun test packages/solutions-builder/src/tracker-prototype/*.test.ts`.
- `scripts/tracker-proof-local.ts` drives the real workflow runtime body through `runLocal`; it rejects a stale review, takes the retry branch, records a stage-two activation intent, validates the second exact artifact, and completes.
- `scripts/tracker-proof-deployed.ts` deployed the action/signal tracker through the real embedded hub and process provisioner without invoking its inert inference offering. Before restart, the run durably recorded `RunStarted`, the first `SignalAwaited`, the platform-stamped `SignalReceived`, a completed validation action, and the second `SignalAwaited` (events 1–10). The caller-supplied principal was overwritten with the authenticated workspace principal before validation. Evidence is preserved at `/var/folders/rr/chkcl_5x2vx0vkwbpx7vz_480000gn/T/sb-tracker-proof-bh6WBT`.
- The workflow signal HTTP handler authorizes `workflow-run manage` or `signal:<name>`, overwrites any caller-supplied `principalId`, requires a stable `signalId`, and uses durable dispatch for provisioned deployments.
- Top-level deployed actions are loaded from the package's `interchange.actions` module and are wired by the production child environment. A mid-action crash is at-most-once at the runtime layer and fails the run; it is not automatically retried.

The focused tests and `runLocal` do not prove deployed behavior; only the preceding event-log observation came from the provisioned deployment.

## Narrow action-seam blocker and native alternative

The current pin's **action primitive** exposes no supported deterministic service seam that can both validate an independent specialist's output from an authoritative store and activate another independently deployed specialist:

- A deployed action receives only `(input, EffectContext, AbortSignal)`. `EffectContext` authorizes and deduplicates a handler-supplied closure; it does not expose the hub transport, artifact store, mail transport, workflow launcher, or credential resolver.
- Tool packages can receive mail transport and consumer-scoped credentials, but tools are invoked inside an agent step from model tool calls. The deterministic action primitive cannot invoke that tool runtime.
- Credential bindings are materialized per tool package and layered onto an agent's tool environment. They are not injected into action handlers.
- The `escalation` primitive only records `{ escalatedTo, payload }` in the workflow log; it does not send mail.
- An action module could call ambient `fetch`, but it has no supported run-scoped platform identity or credential and would bypass the intended transport/capability boundary. The prototype does not do this.

Consequently, `recordActivationIntent` is explicitly an intent in the tracker event log, not proof that an independent specialist was activated. Launch-input evidence is useful for exercising decision validation but is not accepted as authoritative production artifact evidence merely because a browser supplied it.

There is a supported alternative that must be tested before proposing a platform addition. A workflow closure can ship a custom `defineDirector` factory through `interchange.directors`; the probe and deployed run-child both load it. A deterministic `ReactorDirector` can request tool execution without asking a model to choose the operation, and an agent tool package can receive the native mail transport. A dedicated single-step tracker/relay agent may therefore activate an independent specialist by authenticated native mail. This is not yet a complete authority design: its durable state lives at the reactor/context seam rather than in an action output, and authoritative artifact reads still need an approved tool/credential or a content-addressed, signed specialist-completion message. It requires a deployed proof before selection.

If that topology cannot carry authoritative evidence and recovery, the smallest platform addition to compare is an operator-approved deterministic effect/tool invocation seam for actions, backed by a run-scoped service identity, with narrowly typed operations to read an exact artifact version/hash and trigger or mail a pinned deployment. Another alternative is an authenticated specialist-completion signal minted by the platform from the specialist run and carrying a content-addressed output reference. Each needs a deployed reproducer for authorization, deduplication, restart, and partial failure before adoption.

## Still unproven

- End-to-end completion across a host/process restart is blocked. After the host restarted while the run was parked on `tracker.proof.finish`, the authenticated signal endpoint returned 202, but no `SignalReceived` appeared during the following 60 seconds and the run remained at event 10 (`SignalAwaited`). The preserved allocation stayed at generation 1. This is the smallest current restart/dispatch reproducer; a 202 acknowledges durable delivery acceptance, not workflow completion.
- Independent specialist activation and authenticated output handoff.
- Concurrent HTTP signal submission in this application topology.
- Arbitrary repeated send-back, reapproval, downstream invalidation, and isolation from old specialist replies/tool approvals.
- Recovery after the intentionally failed deployed action. The inspected runtime semantics say the run fails and does not retry; application recovery policy remains to be designed.

No tracked vendor files were changed and no provider inference was invoked.
The isolated host uses its normal secret store; credentials are not included in
the report, source, or commits. The handwritten `types/intx.d.ts` shim has been
removed; Interchange imports resolve through actual package exports.

## Integrated verification

Coordinator reran the nine focused tests (9 passed) and local runtime proof
(passed, 24 events). `bun run check` passes shard, migration, and boundary checks
but fails typechecking against real package declarations. Existing integration
type mismatches and a changed UI prop remain unresolved; this is not a green
product gate. No further package/UI work is authorized at this checkpoint.
