> **Superseded (2026-09-20):** this document describes an approach that was superseded when the native project workflow shipped as one top-level loop in `packages/solutions-builder/src/project-workflow`. Authenticating specialist output turned out not to be required — mail is authenticated at ingress. See `packages/solutions-builder/src/project-workflow/README.md`. Kept below unchanged for historical record.

# Stopped-work handoff: reassess the coordination assumption

**The user stopped implementation. No further implementation, tests, inference, automatic retries, or upstream changes are authorized this turn.** This document is a handoff, not permission to resume.

**Native workflows and stages have not been shown broken.** The selected coordination path has not established how the owning workflow can authenticate that an exact specialist output came from the expected deployment and belongs to the expected project, stage, and revision. One inspected mail-verification path lacks its sender-key resolver. That is a specific limitation of the selected path—not proof that the requested architecture, or every supported native composition, is impossible.

The next agent should challenge our trust-model assumptions and scope, not accept “blocked” by authority. Work narrowed into proofs rather than delivering the requested workflow. The production experience has not been cut over.

## 1. What the user actually wants

Start from [PLAN-internal-beta-experience.md](PLAN-internal-beta-experience.md), not from a new platform audit:

- One application-defined Interchange project workflow owns stages, reviews, and decisions.
- Conversational stage specialists remain separate, independently deployed specialists.
- Restore all nine stages of main's functional/process experience, then enhancements. Main is the behavior reference, not a backend to copy.
- The UI submits intent and projects committed evidence. It must not become process authority; no parallel product backend, state store, or control plane is accepted.
- Quality code matching the recently updated local plan is the priority. Live provider inference was explicitly deferred; it is not the next automatic step.

The latest user constraint permits native work but says upstream Interchange may **not** be touched. The primary agent conservatively interpreted this as **no upstream, vendor, or pin changes**. Record and preserve that interpretation; a future agent may clarify it with the user, but must not infer permission. Older plan/README suggestions about an upstreamable patch are historical possibilities, not authorization. No vendor correction was performed in this work.

The user has not approved weakening authority, trusting caller-provided producer metadata, or merging the specialists into a different architecture merely to avoid the unresolved question.

## 2. Actual current state and preservation

- The existing production browser path still writes approved artifacts and `stageFloor`. The tracker prototype is not the production process authority and has not replaced that path.
- There are many preexisting dirty UI, package, and type-configuration changes, plus new untracked proof files. No exact current count is asserted. The reported work is uncommitted. Preserve **all** dirty work, including work unrelated to this handoff; do not reset, clean, discard, commit, or remove directories as a convenience.
- The bounded prototype validates synthetic review decisions and records activation intent. It does not activate real specialists, ingest authenticated live specialist completion, or prove arbitrary revisions/send-back.
- No connected nine-stage browser journey, main parity, or actual use of the resulting deliverable has been proven.
- This handoff adds only `WE_ARE_BLOCKED.md`; it neither changes the operator plan nor repairs implementation.

## 3. The small blocker, without the architectural overclaim

The workflow needs a defensible reason to associate a particular output with the work it asked a specialist to do. A deployment name in a payload is a claim, not authentication. A pinned code definition identifies code, not necessarily the producer of a particular output. A valid signature on content does not automatically authenticate an unsigned reply-correlation header.

For the selected deterministic mail-reader path, source inspection found the top-level workflow child receives `getCrypto: () => undefined`. Native full mail reads therefore report an unknown signature status rather than authenticating the sender. Host deployment-key registration/cache does not, by itself, supply the child with that resolver. This is a **missing verification facility**, not an observed false-valid signature bug.

Even resolving that mail seam would not alone prove the required link between exact content, authenticated producer, project/stage/revision, and any required deployment/definition closure. Whether the proposed trust model truly needs per-deployment provenance—and whether a simpler supported native composition already supplies sufficient authority—remains a question, not a settled platform requirement.

No new identity registry, ambient `SIDECAR_TOKEN` access/copying, private-key sharing, substitute browser authority, or speculative persistence layer is accepted. The native full `CryptoProvider` interface includes signing/private-key construction; any future verifier proposal must be public-key-only at this boundary, not distribute signing credentials. This is a security constraint, not permission to implement an upstream fix.

## 4. Evidence ledger: what was executed, inspected, and left unknown

The following results are **supplied prior execution/review reports**, not fresh verification by the handoff writer. For this document, only the plan and bounded prototype documentation/script references were read. No tests, deployments, or inference were run.

### A. Executed deployed synthetic restart proof

Files: `scripts/tracker-proof-deployed.ts`, `scripts/tracker-proof-host.ts`, `scripts/tracker-proof-evidence.ts`, `scripts/tracker-proof-evidence.test.ts`, `scripts/tracker-proof-safety.ts`, `scripts/tracker-proof-safety.test.ts`, and package test registration.

- Host-only restart and workflow-child loss each produced 16 events with `RunCompleted`, one finish execution, settled `finish-1`, and no validation replay.
- Provisioned-worker loss produced 10 events and no completion. Allocation generation 2 was released with `sidecar_connect_failed`; automatic replacement was disabled. Do not describe this as successful worker recovery.
- Critics/Warden reviewed the safety changes after fixes. The focused evidence/safety suites reportedly passed: 14 tests, 48 assertions.
- Two `SignalReceived` events per signal were attributed to native symmetric writers; that is not automatically evidence of double execution.

These are deployed **synthetic** workflow results, not proof of live specialist coordination or general exactly-once external effects.

**Credential safety:** runtime data roots contain credentials. Share only the deliberately sanitized files under `sanitized-evidence` (`*.json` / `*.jsonl`), never raw logs or runtime roots. Retained private data-directory locations are intentionally omitted here.

### B. Executed synthetic review-decision unit

Files: `packages/solutions-builder/src/tracker-prototype/actions.ts`, `workflow.ts`, `review-runtime.test.ts`, [README.md](packages/solutions-builder/src/tracker-prototype/README.md), and `scripts/tracker-proof-local.ts`.

- Validation overwrites nested caller identity with the top-level HTTP-stamped principal. Missing top-level identity fails closed. Local tests supply that stamp synthetically; they do not authenticate an HTTP caller.
- Only accepted `approve` proceeds. Accepted `send_back` does not. Both first decision and retry are gated.
- Retry exhaustion records `{ exhausted: true, proceed: false, validation }`; downstream activation/wait/validation is skipped. Runtime completion of this finite branch is not project approval.
- This is one retry against the same review, not revision generation or arbitrary send-back/reapproval.
- Fresh Critic/Warden reports had no blockers for this bounded unit. Reported tests: 21 tests, 86 assertions; local proof: 28 events.

Review/input evidence remains fixture-owned. Activation intent is not actual activation. Claimed producer fields are not authenticated specialist provenance.

### C. Executed negative diagnostic, with a source guard—not deployed assembly

File: `scripts/tracker-proof-coordination.ts`.

The diagnostic uses ephemeral native signed MIME, the native verifier, `SupervisorBackedTransport`, and `mail_read`, with an in-memory reader and textual production-source guard. It does not boot the deployed assembly.

- Known sender resolver: valid native signed fixture validates.
- Missing resolver: the same bytes report `unknown`.
- Wrong key or tampered signed content with a resolver: `invalid`.
- Unsigned content with a resolver: `missing`.
- Absent resolver: tested valid, tampered, and unsigned inputs all report `unknown`.
- Altering outer `In-Reply-To` leaves the signature valid. That outer header is not authenticated correlation.

Exit 2 means the diagnostic controls passed **and the selected seam remains blocked**. Exit 1 means diagnostic error. It uses existing tools-mail `dist`; it is not certification of a fresh vendor build.

Previously inspected source chain, relative to `vendor/interchange/` (line numbers are inspection coordinates, not immutable anchors):

1. `apps/sidecar/src/workflow-substrate-factory.ts:2195–2206`: `getCrypto: () => undefined` in `transportInbound`.
2. Same file, top-level `buildStepEnv:2308`: passes that inbound transport; `createSidecarStepBuildEnv:1117–1128` builds the sidecar transport; `invokeStep:2503–2533` is the inspected invocation path. This is not solely a nested-child claim.
3. `packages/workflow-host/src/child/supervisor-backed-transport.ts:270–277`: delegates full reads to the verifier.
4. `packages/mailbox/src/fetch.ts:181–191`: returns `unknown` without a resolved sender, before byte verification.
5. `packages/tools-mail/src/handlers.ts:270–289`: returns signature status.

### D. Bounded alternative assessment: source only

Greybeard's supplied review considered native signals and artifact completion as alternatives. It did not exhaust all native compositions:

- The inspected signal route stamps an authorized **user** principal, not a producer deployment: embed-hub auth session, hub-api tenant/user middleware, and `vendor/interchange/packages/hub-api/src/routes/workflows.ts:518–535`.
- Allocation harness `sourceAuthorityPrincipalId` can be shared across deployments. A credential-provider HTTP bearer does not itself establish a deployment bearer accepted by the signal API.
- `@corbits/artifacts` has `mountWorkflowArtifacts`, which can stamp `source.runId` through a resolver. The app currently mounts the tenant artifact surface instead.
- The native host sidecar-token authenticator has allocation identity, but a supported consumer-scoped allocation-token path to the tool was not established. “Not established” is not proof that none exists.
- Frozen deployment/closure evidence and durable events/blobs exist natively. The missing demonstrated bridge is from exact output to authenticated producer plus project/stage/revision—not a general absence of native storage or workflows.

### E. Repository gates and unproven product behavior

Reported `bun run typecheck`, `bun run check`, and `bun run check:full` each exited 2. Shards, migrations, and boundaries passed before typecheck stopped downstream gates. Reported diagnostics were outside changed prototype paths: embed-hub allocation/auth/module contracts, web design elapsed prop, grant tests, and installer/tools/registry.

No handwritten `types/intx.d.ts` was restored; real declarations exposed errors. Attribution to baseline/other work is based on reports, **not a clean-baseline comparison proving every error preexisted**. Baseline type cleanup could be separate optional work if authorized; it is not a solution to specialist coordination. Full gates and all nine-stage/product acceptance remain unproven.

## 5. Reproduction reference—do not run automatically

These commands are for a later, explicitly authorized reproduction. They are not a request to restart work now.

| Command | Supplied result or exact interpretation |
| --- | --- |
| `bun test packages/solutions-builder/src/tracker-prototype/*.test.ts` | Reported exit 0; 21 tests, 86 assertions. Synthetic review/runtime coverage only. |
| `bun --conditions intx-src scripts/tracker-proof-local.ts` | Reported exit 0; 28 events. Synthetic activation-intent proof. |
| `bun --no-env-file --conditions intx-src scripts/tracker-proof-coordination.ts` | Reported exit 2: controls pass, selected coordination seam blocked. Exit 1: diagnostic error. No inference/deployment. |
| `bun test scripts/tracker-proof-evidence.test.ts scripts/tracker-proof-safety.test.ts` | Focused reproduction command for the reported 14 tests / 48 assertions; original invocation not independently verified here. |
| `bun --no-env-file --conditions intx-src scripts/tracker-proof-deployed.ts` | Script entry point for all three synthetic scenarios, not a claimed verbatim prior invocation. Script sets exit 1 on scenario failure; completion/recovery claims must be read from sanitized per-scenario evidence, not inferred from process exit alone. Prior aggregate exit not supplied. Launches local processes and retains private runtime data; requires separate authorization. |
| `bun run typecheck` | Reported exit 2. |
| `bun run check` | Reported exit 2; stops at typecheck, downstream gates not certified. |
| `bun run check:full` | Reported exit 2; stops at typecheck, downstream gates not certified. |

Do not rerun until authorization and scope are clear. Do not turn a negative diagnostic's exit 2 into a green product acceptance claim.

## 6. Paths to preserve and read selectively

This is a useful-path inventory, **not an exhaustive git diff**. Existing dirty files are not disposable merely because they are absent here.

- `PLAN-internal-beta-experience.md` — user plan; unchanged by this handoff.
- `packages/solutions-builder/src/tracker-prototype/` — bounded prototype, tests, and README; limitations above apply.
- `scripts/tracker-proof-local.ts`
- `scripts/tracker-proof-coordination.ts`
- `scripts/tracker-proof-deployed.ts`
- `scripts/tracker-proof-host.ts`
- `scripts/tracker-proof-evidence.ts`
- `scripts/tracker-proof-evidence.test.ts`
- `scripts/tracker-proof-safety.ts`
- `scripts/tracker-proof-safety.test.ts`
- `package.json` — includes reviewed test registration among existing changes.
- `apps/web/src/pages/workspace/`, `apps/web/src/decisions-fold.ts`, `apps/web/src/pending-approvals.ts`, `apps/web/src/project-list.ts` — existing dirty UI work; not changed or newly audited for this document.
- `bun.lock`, `tsconfig.typecheck.json`, `types/` — preserve existing dependency/type work; no baseline repair authorized here.
- `vendor/interchange/` — source references only for this work, not permission to modify or reset existing local patches.
- `WE_ARE_BLOCKED.md` — the sole file added by this documentation turn.

## 7. Questions and bounded next reassessment

**Stop here now.** The user requested this handoff, not continued implementation or automatic retries. A later agent should obtain authorization before acting on the following bounded reassessment:

1. Read the user plan and restate the smallest required workflow behavior, keeping independently deployed conversational specialists and workflow-owned decisions. Do not substitute a sprawling audit for that deliverable.
2. Ask whether per-deployment provenance is necessary in the proposed trust model, or whether an already supported native authority boundary satisfies the user's actual requirement. Do not silently weaken authority; explicitly distinguish code pinning from unforgeable output attribution.
3. Check whether the earlier bounded review overlooked supported deterministic native communication or artifact completion, including existing run/allocation identity. Require a concrete supported path, not caller-supplied labels, token copying, or a new identity registry. The supplied source-only assessment is challengeable, not an impossibility theorem.
4. Keep arbitrary repetition, revisions, and send-back/reapproval open: the finite same-review retry has not solved them. Do not mistake synthetic review validation or restart results for the complete product workflow.
5. If a candidate survives, propose only the smallest non-inference proof needed to distinguish it from the current failed assumption, with explicit authorization and stop conditions before execution. If none survives that bounded check, report the exact unresolved boundary and ask the user—do not automatically patch upstream/vendor/pins or redesign the authority model.

Any ambiguity about “do not touch upstream” must be clarified, not treated as permission. Resume from the plan and a narrowly stated question; no further work is authorized by this handoff itself.
