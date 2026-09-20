# Internal beta: guided behavior, consistent UI, and a better path to delivery

Planning baseline: `internal-beta` at `f96eb557`, 2026-09-19. Main is the experience reference; internal-beta supplies the architecture. This is a proposed backlog, not a claim of implemented or tested behavior. No Linear tickets are created by this plan. Ticket labels below are local planning identifiers.

## Delivery strategy: parity first, enhancements second

The first release target is 1:1 functional and process parity with `origin/main` across all nine stages, implemented through internal-beta's application-driven architecture. Restore what a person can do, how specialists guide them, what decisions they make, and how work reaches delivery. Main is the behavioral specification, not a backend implementation to copy.

Pin the reference main commit during B01 so acceptance is reproducible. Inventory every user-visible function and process transition, including guidance, questions, revisions, approvals, exports, settings, notifications, errors, and recovery. For each, record main's observed behavior, internal-beta's current behavior, the architecture-compatible implementation path, and an executable acceptance scenario.

The phase and ticket inventories below describe the full scope, but they do not all belong in the parity release. Classify each item from the baseline comparison:

- **Parity:** restore an observed main capability or process, including its interaction and visual quality.
- **Required correctness:** make that capability truthful, secure, and reliable under the chosen architecture.
- **Enhancement:** behavior beyond main; defer until parity is demonstrated end to end.

Do not redesign a working main interaction merely because a different interaction seems preferable. Reuse suitable UI and product logic where compatible; adapt their data and execution paths to supported platform capabilities. New response contracts, additional agents, expanded design systems, and new guidance behavior are proposals, not automatic prerequisites for parity. Introduce them only where the comparison establishes a need.

If a main capability lacks a supported platform surface, document the exact gap and resolve it through the proper application or upstream extension point. A weaker substitute is a recorded parity gap, not a completed feature. Do not recreate host product routes, add a parallel persistence/control plane, or fabricate unsupported state to make the parity matrix appear green.

**Parity exit:** all inventoried functionality and process scenarios pass, all nine stages are exercised as one connected journey, the resulting deliverable is actually used, visual/interaction quality matches the baseline, recovery is proven, and `bun run check` passes. Any unresolved difference remains explicit; do not declare 1:1 parity with outstanding gaps.

**After parity:** prioritize the enhancements below using the observed friction from that complete journey. This is when the product moves beyond main, with a stable baseline for measuring improvement.

## Parity gap inventory and native surfaces (2026-09-19)

Source-inspected, not browser-driven. Main = `origin/main` `e39e8513`; beta = `f96eb557` + working tree; Interchange = vendor pin `79adc433`; packages = `@corbits/artifacts@24350a4`, `@corbits/mailbox@65590a8`, `@corbits/react-ui@3b12281`. `HANDOFF-internal-beta-parity.md` §3.3, §3.5 and §3.8 build recipes are superseded by this section (client-nulled `approvedAt`, `rm -rf` retry and client send-back contradict the tracker authority); main's observed behaviour there remains the spec.

### Client-driven rule

The browser submits intent and renders committed evidence. Intent = `POST /workflows/:runId/signals` with a caller-minted stable `signalId` (the state machine dedups on it; reuse with a different payload is 409; `principalId` is server-stamped). Committed state = the tracker's event log (`GET /workflows/:runId/runs/:eventRunId/events`, full log per call, dedup on `seq`) with `StepCompleted.output.ref` decoded inline or fetched from `.../blobs/:sha`. The client reduces that log; it never writes `approvedAt`, never infers the cursor, and holds no product state beyond per-viewer conveniences. No new host routes.

### Verified platform facts that constrain the design

| Need | Native surface | Consequence |
| --- | --- | --- |
| Review bound to a hash | None. `@corbits/artifacts` has no digest field and no optimistic concurrency (`FOR UPDATE`, last write wins). Beta's `contentHash` is `<id>@<version>`. | The tracker action computes sha256 over the fetched content and commits `{artifactId, version, sha256}`. The UI shows that, not its own hash. |
| Old version content | `GET /artifacts/:id/versions` returns metadata only; bodies are reachable only through agent tools. | Revision compare uses mail replies or content the tracker pinned; R05 restore is a package gap. |
| Incremental assistant text | None. `inference_turn`/`turn_part` are write-only; `observability.ts` and `agent-data.ts` are 501 and default-denied; no SSE in hub-api. | Recorded parity gap and upstream ask. Do not simulate. |
| Tool stdout / exit status | None. Arguments are visible only while an approval is pending; results are never surfaced. | Stage 8 output must come from evidence our own tool writes (an artifact), or stay unknown. |
| Token / cost usage | None. No token or cost column exists; wallet ledger has no model attribution. Price rates are readable (`GET /models`). | Spend is a recorded gap and upstream ask. |
| Cancel a run or turn | `DELETE /workflows/runs/:runId` is mounted and returns 501 (INTR-454). No deployment release route. | Main never cancelled the model call either (see withdraw below), so parity does not need it. |
| Provider model refresh | None; model-provider routes are CRUD only. | Re-run the connect-time discovery client-side, or record the gap. |
| Pending approvals | `GET /approvals` is pending-only, no run filter. Approve/reject on a released allocation is 409 and the approval stays pending forever. Resolved approvals are readable by id. | Filter by deployment status client-side; upstream ask for expiry. |
| Reply arrival | Tenant-scoped mailbox SSE exists: `/api/tenants/:t/mailbox/me/inbox/events` (id-only nudge, refetch). | Replace the 3 s thread poll. |
| Binary artifacts | `POST /artifacts/upload` (multipart, 10 MB/file) accepts pptx/pdf/docx/xlsx/images; `GET /artifacts/:id/download`. gzip/tar is rejected (415). | Templates and material use the upload route; the build archive stays data-URL text (15 MB cap). |
| Text extraction, deck generation, export/import, spend | No corbitsdev package. | Browser-side libraries or recorded gaps. |

### Main capabilities absent from earlier inventories

| Capability | Main behaviour | Client-driven path | Class |
| --- | --- | --- | --- |
| Withdraw / Stop | Aborts the wait, restores the sent text and quotes to the composer, marks the round withdrawn; the model call still completes and its answer is discarded. Turn shows "Stopped before it was answered." | Durable withdrawn marker keyed by the sent `messageId` (artifact metadata, not localStorage); the fold hides the late reply and never uses it as the draft. | Parity |
| Material reading | Fold showing the exact text specialists receive: text/JSON verbatim, xlsx per sheet, PDF per page, images/Word/PowerPoint name-only; every cap announced. That text fed every stage prompt. | Extract in the browser at attach time (unpdf, exceljs), store as a companion artifact, feed it through the context handoff. | Parity |
| Project export | JSON bundle (project, policy, ledger, build events, conversations, artifacts with bytes), never overwriting. | Client assembles from artifacts, mail threads and tracker events; browser download. | Parity |
| Project import | Re-mints ids and replays the ledger into a new project. | Needs a tracker replay design; recorded gap until the tracker contract settles. | Parity, blocked |
| Refresh models | Re-validates the provider, re-registers the catalog, clears a selected model the provider dropped. | Reuse the connect-time discovery path. | Parity |
| Save artifact file | Host wrote to Downloads. | Beta's `downloadArtifact` browser download is an accepted substitute. | Intentionally changed |
| Deck save and print | Worked. | Beta still calls `/artifacts/:id/slides/save` and `/api/artifacts/:id/print`; a source search finds no handler for either. Generate the pptx in the browser with `deck.ts` (pptxgenjs); print client-side. | Regression |

### Process behaviour the tracker must reproduce

- **Send-back:** any stage 1..current (target = current means redo here), reason required; nothing is deleted; stages target..current are walked again and each specialist revises its current document; the reason arrives as the next human turn; a recorded target cannot be re-aimed.
- **Stage 5:** approval refused (`quorum_not_met`) with no decisions, any non-proceed decision, or proceeded < quorum; quorum is 0..count from project policy; the UI disables Approve and explains.
- **Stage 7:** cost approval pins a version; freeze writes a `build_packet` naming the exact frozen versions, target and cost approval; freeze without cost approval, a second freeze, and stale versions are all refused.
- **Stage 8:** one workspace per attempt; "continue" copies the prior workspace minus `.corbits`, "from scratch" starts empty, prior directories retained; exit status is not a verdict; accept is refused while the worker runs.
- **Idempotency:** a repeated command is answered from its receipt (`replayed`), which the signal `signalId` dedup provides natively.

### Reuse before building

`@corbits/react-ui` already ships `agent-turn`, `quick-reply-chips`, `approval-card`, `gate-block`, `live-status-line`, `activity-timeline`, `progress-checklist`, `stat-tile`, `file-input`, `notifications-bell`. Prefer these over hand-rolled equivalents; `compare-body` is side-by-side variants, not a line diff, so `revisions.ts` stays.

## Outcome

A person can start with a vague problem, work with a thoughtful specialist, understand each decision, and receive a verifiable, usable deliverable. At every point they can tell what is happening, what needs their attention, and what happens next. The interface feels like one product across all nine stages, Projects, Decisions, Settings, and artifacts.

The completion target is the entire nine-stage journey. Stages 1–3 are an implementation checkpoint, not a release boundary or a sufficient result. Guidance, continuity, polish, recovery, and human review apply at every stage. The work is complete only when a person can go from an opening idea to running the delivered result, including revision and recovery along the way.

Priority order: guided behavior and continuity; reliable decisions and recovery; useful stage-specific interactions; visual consistency and polish throughout. Visual foundations start early, rather than waiting for a final cosmetic pass.

## What inspection establishes

- `kit.ts` already describes constructive brainstorming, bounded questions, assumptions, likely answers, and human authority. Preserve and improve this behavior rather than replacing it with generic chat.
- The live workspace projects mail into turns with `questions: null` and passes `openQuestion={null}` to `StageDocument`. The interview contract promised by the prompts is not fully connected to the current interaction.
- `StageDocument`, `SpecialistTurn`, choice parsing, revision UI, and advisory gate components provide reusable pieces. Their presence does not establish that their behavior works in the mounted app.
- Stage openings currently pass the previous approved document. That alone does not guarantee preservation of earlier constraints, source materials, decisions, or corrections.
- Main's guide and guidance smoke establish a valuable product requirement: every state needs a meaningful next action. Their old host implementation is not the implementation to restore.
- `WorkingLabel` rotates descriptive activities on a timer. Those phrases must not be presented as observed runtime activity.
- Some repository instructions still describe the retired lifecycle while current stage progress is artifact-derived. Reconcile documentation with actual contracts before changing state semantics; do not introduce a second state machine.

## Architecture and safety constraints

### Package composition and UI boundary

All Solutions Builder-specific UI belongs in `apps/*` (primarily `apps/web`). Reusable specialist definitions, native workflow definitions, tool bundles, and data contracts belong in packages. Shared Corbits UI components remain library dependencies; product pages and interaction components do not move into agent/workflow packages.

Package composition does not require nested runtime child workflows. An umbrella Solutions Builder package can compose independently deployable specialist packages and a tracking-workflow package through npm dependencies and pinned deployment references. Each specialist should export a configurable native definition and ship a usable `interchange.workflow` entry, with a focused prompt, declared tools/grants, input/output contract, and no dependency on the Solutions Builder UI or project-specific globals. The Solutions Builder composition supplies project IDs, stage mapping, approved context, deployment configuration, and house policy. Reusable specialists should not bake the full nine-stage process or a compulsory product stack into every prompt.

Candidate package boundaries (names provisional): contracts; individual specialist packages; tracker workflow with its action/loop exports if required; tool packages; installer/client transport; and an umbrella composition package. Do not split files merely to create more packages: a boundary should enable independent deployment, reuse, versioning, or testing. Move deck/delivery helpers out of the umbrella where necessary to avoid tools depending back on the entire application.

Today the app and tools are private workspace packages, stage source is generated per project, and every stage asset carries the app/deck/delivery closure. This is useful deployment machinery, but not yet a set of independently consumable specialist npm packages. Package-readiness acceptance must include packing, inspecting contents for secrets/local paths, installing in a clean consumer outside this monorepo, resolving pinned dependencies, deploying one specialist without the Solutions Builder UI, and then deploying the complete composition. Use the native dependency-closure resolver; do not replace it with another resolver. Publishing is a later explicit action, not part of this investigation.

Workbench reference inspected at `ec8bbbad7f6e150c9b67b75fcdf5b2342acb770f`: its [architecture](https://github.com/corbitsdev/workbench/blob/ec8bbbad7f6e150c9b67b75fcdf5b2342acb770f/ARCHITECTURE.md) separates web UI, hub composition, and domain packages. [`@corbits/myra`](https://github.com/corbitsdev/workbench/blob/ec8bbbad7f6e150c9b67b75fcdf5b2342acb770f/agents/myra/package.json) exports a configurable native workflow builder and an `interchange.workflow` entry. Its builder explicitly retains one step for warm conversation behavior. Follow these boundaries and native deployment conventions; do not infer that Workbench proves our nine-stage tracker.

### Upstream issue check and vendor-patch decision

Linear read on 2026-09-19 confirms:

- [INTR-480](https://linear.app/abklabs/issue/INTR-480) is Done, specifically for warm single-step conversational mail. It does not establish nested conversational-agent support.
- [INTR-541](https://linear.app/abklabs/issue/INTR-541) is Backlog: owned child workflows cannot receive mail/signals through the terminal-only child seam, including human gates below that boundary; restart/redeploy support is part of the unresolved capability.
- [INTR-400](https://linear.app/abklabs/issue/INTR-400) is Todo for external signals into onTrigger bodies. Its description and later relay code should be tested against the exact deployed topology rather than equated with blanket absence of signal support.
- [INTR-402](https://linear.app/abklabs/issue/INTR-402) is Todo for per-turn signal correlation. FIFO-by-name can deliver a late decision to a later await. Stable signal IDs deduplicate retries but do not establish review identity: application validation must check stage, review ID/revision, artifact version, and hash.
- [CL-8606](https://linear.app/abklabs/issue/CL-8606) and [CL-8608](https://linear.app/abklabs/issue/CL-8608) remain Backlog in the Corbits team, with upstream filing still unchecked. Do not describe these as confirmed filed INTR issues. The PATCHES.md reference to INTR-568 could not be resolved through the connected Linear fetch, so its live status is unverified.
- [CL-8576](https://linear.app/abklabs/issue/CL-8576) records both the cold-agent reply failure and one input channel per run, which previously forced a combined specialist prompt. Independent deployments preserve separate conversations and focused prompts.

Recommendation: keep reusable single-step specialist deployments and investigate a deterministic native tracker. A vendor fix for nested mail is not presently the smaller path: it involves durable connector seeding/thread identity, reply drains and send-settlement, inbound routing, attachments, park/resume, and restart/redeploy behavior, in addition to the distinct child-signal and nested-action blockers. Enabling a reply callback alone is insufficient. A narrowly reproduced native tracker blocker may still justify a small, documented, upstreamable vendor patch; evaluate that separately rather than taking on the whole nested-conversation capability.

The remaining tracker question is repetition: a static workflow graph rejects dependency cycles, so arbitrary send-back cannot be a backward edge. A native loop around deterministic decision processing is a candidate, distinct from nesting conversational agents, but it still exercises relay/sequence behavior and needs a deployed proof. Another native composition may be preferable if already supported. No browser-maintained state machine, artifact timestamp bypass, or LLM-decided transition is an acceptable fallback.

### Native workflow verification (2026-09-19)

Upstream `faremeter/interchange` main and our declared vendor pin both resolve to `79adc43350a535e808439f05b71ec70aa00490a0`. Local differences remain documented in `vendor/interchange/PATCHES.md`; matching the pin does not mean this vendor tree is byte-identical to upstream.

The process authority must be an application-defined Interchange workflow. Artifact metadata is evidence/projection, not permission to advance. The UI submits intent and reads committed results. This supersedes any interpretation of this plan that preserves browser-owned stage transitions.

Verified native surfaces:

- `awaitSignal` durably parks a workflow. The workflow signal API checks run-management or signal-specific grants, stamps the authenticated `principalId`, requires a stable signal ID, and uses durable dispatch for provisioned deployments. A 202 response acknowledges delivery acceptance, not completion of the product decision.
- Native tool approvals use a separate resolution path. Reserved approval/input signal names are explicitly rejected by the ordinary workflow signal route, preventing that route from bypassing approval authorization. Use tool approvals for permissions and author-named workflow signals for product review where appropriate; these are distinct native mechanisms.
- `action` handlers are exports from the deployed package's `interchange.actions` module. This is the application-owned place to validate decision payloads and product invariants within native execution; it does not require a product route or handler hardcoded into the hub. Inputs must be validated against authoritative evidence, not trusted merely because the sender is authenticated.
- `childWorkflow` embeds an owned child definition whose grants join the approved deployment surface. It does not attach to an already-deployed specialist ID. Existing unbounded mail specialists do not terminate on their own, so a tracker must not simply wait for one as a completing child.
- Loops support signal waits and child workflows, with restrictions. A loop body cannot contain `sleep` or `onTrigger`; simultaneous sibling loop signal parks are an explicitly unsupported resume topology. An action interrupted mid-invocation fails on resume rather than being automatically replayed. Recovery needs explicit design.

Recommended investigation: a small deterministic tracking workflow owning stages and reviews, with stage specialists doing their work in native workflows. Compare (A) bounded owned stage children and (B) independent existing mail specialists coordinated through supported native communication. Prefer the smallest composition that proves authority, provenance, and recovery. Keeping independent specialists requires an authenticated completion/reference protocol; a browser's assertion that work finished is not sufficient.

Historical blocker follow-up: commit `f66c14f9` records a live-provider reproduction in which a standing specialist inside the multi-step lifecycle completed turns but delivered no mailbox replies. The current step invoker still attaches `driveReplies` only in `invokeWarmStep`; multi-step workflows do not receive the single-step warm cache. This explains the separate mail-specialist deployments introduced by PR #409. PR #423 later removed the lifecycle, its action module, and its signal grants. Do not undo that separation merely because generic child/loop unit tests pass.

The deployed spawned-body environment in `apps/sidecar/src/workflow-substrate-factory.ts` also differs from the top-level environment: the inspected environment literal does not wire `invokeAction`, and its documented suspension boundary services approval parks rather than external input parks. The top-level action loader's successful tests therefore do not prove actions or interactive signal waits inside those spawned bodies. Treat these as concrete source-level constraints requiring deployed reproduction, not resolved upstream issues. Separately, PATCHES.md documents the fast-round duplicate signal/sequence conflict and its local retry mitigation (INTR-568), plus the nested leaf credential risk. Upstream main has not advanced beyond the current pin.

Consequently, the leading candidate is to preserve independent, single-step conversational specialists and investigate a separate deterministic tracker with top-level native review waits/actions. Avoid child/onTrigger/loop nesting in the first proof. Send-back/repeated reviews still require proving a native repeat/routing strategy; this preference is not evidence that a simple static nine-step DAG handles arbitrary backtracking. If the required native topology remains blocked, record a precise upstream reproducer rather than reinstating browser-owned transitions.

Verification performed: read definition types, deployed package action loading, workflow signal handler, approval resolution, runtime constraints, and upstream deployed restart test source. Ran four focused suites covering loop signal waits, loop children, loop resume boundaries, and package definition/action loading: 33 passed, 0 failed. Upstream contains a real sidecar restart test asserting completed pre-park work is not repeated; it was inspected, not executed here. These checks do not prove a Solutions Builder tracker deployment.

Remaining proof before architecture adoption: deploy a two-stage tracker through this app's process provisioner; draft through a real specialist; review an exact artifact/hash; reject unauthorized, stale, duplicated, and out-of-order decisions; advance only on committed validation; send back and reapprove; restart while parked; and verify recovery from a failed action. Inspect nested credential pinning explicitly: PATCHES.md records a possible loop-body leaf credential gap. Reproduce the previously reported action-in-onTrigger and anchor sequence failures on the selected topology before claiming they are fixed or avoided.

Current verification limits: `bun run check` stops because `smoke:e2e` is unassigned to a gate shard. An initial test command also invoked the repository test script, which exposed missing dependencies and a first-run expectation failure; the corrected focused invocation passed. No vendor changes or production workflow deployments were made during this audit.

Source references: [native workflow contract](https://github.com/faremeter/interchange/blob/79adc43350a535e808439f05b71ec70aa00490a0/packages/workflow/README.md), [definition primitives](https://github.com/faremeter/interchange/blob/79adc43350a535e808439f05b71ec70aa00490a0/packages/workflow/src/definition/primitives.ts), [workflow signals](https://github.com/faremeter/interchange/blob/79adc43350a535e808439f05b71ec70aa00490a0/packages/hub-api/src/routes/workflows.ts), [deployed restart test](https://github.com/faremeter/interchange/blob/79adc43350a535e808439f05b71ec70aa00490a0/tests/workflow-deploy/loop-work-then-signal-restart-resumes.test.ts).

Code audit clarification (2026-09-19): Interchange is the platform. Corbits packages are reusable packages and solutions, not a separate platform. The current specialist execution is native Interchange; the nine-stage product process is not currently a nine-stage native workflow. `specialist-source.ts` generates a mail-triggered `defineWorkflow` with a `defineAgent` step; the installer deploys its asset at a commit. Stage approvals instead call `persistStageDraft` in the web client, persist `sb.approvedAt` through the mounted artifacts package, and advance through an artifact-derived cursor. Native tool approvals are a different path.

Before restoring process parity, resolve the enforcement boundary: `guard.ts` describes the sole transition enforcement point, but a source search found no callers of its `evaluate` function in the current apps, installer, or app package. Its presence is not evidence that the current stage-approval path enforces authority, hashes, or cost constraints. The current `contentHash` is an artifact/version identifier, not a cryptographic hash. Product decisions need an authoritative application-owned validation path using supported Interchange capabilities, not only browser conditions. Select that path after inspecting the relevant native handlers; do not assume restoring the retired lifecycle is required.

Classify package code before changing it: active specialist definitions/prompts; shared product contracts and presentation helpers; sidecar tool helpers; and retained lifecycle-era code. In particular, `project-state.ts` retains old lifecycle projections (current UI imports its feedback type), `guard.ts` is not wired into the traced approval flow, and `manifest.ts` retains the lifecycle name for compatibility. Review consumers before removing or repurposing any of these. No package cleanup or runtime migration is authorized by this audit alone.

- Preserve the embedded hub and existing platform-owned authentication, tenancy, mail, approvals, provisioning, and persistence capabilities. No product backend rebuilt inside the host.
- Shared product contracts and pure interpretation belong in the app package; transport operations use the approved installer/client surfaces; the UI renders evidence and issues supported requests. Confirm exact placement against boundary checks before implementation.
- Search and read platform handlers and types before proposing a missing capability. API investigations are explicit dependencies, not assumed feature availability.
- Agents draft and recommend. People approve. Guidance is a read projection, not another source of authoritative project state.
- Approvals identify the exact artifact versions and required hashes. Changing the reviewed input makes an old recommendation or decision visibly stale.
- Credentials stay out of source, commits, mail, prompts, logs, and artifacts. Execution receives supported secret references; UI receives status only.
- No directory removal without user confirmation. A fresh build attempt gets a new isolated directory, retaining the prior attempt.
- No fabricated progress, readiness, costs, execution results, feedback resolution, or delivery success. Missing evidence is visibly unknown.

## Phase 0 — establish the reference and contracts

| ID | Work | Acceptance |
| --- | --- | --- |
| B01 | Walk equivalent scenarios on main and internal-beta; capture screens, interactions, dead ends, and useful behavior. | A parity matrix marks each item retained, regressed, intentionally changed, or newly proposed, with evidence and revision. |
| B02 | Audit available mail, artifact history, run events, tool results, usage, approval, and deployment APIs. | Each planned feature names its supported read/write surface or an explicit upstream dependency. No inferred APIs. |
| B03 | Reconcile stale architecture and contributor instructions for this branch. | Current contracts and branch conventions are documented; any checker change has a deliberate justification. |
| B04 | Record the current check gate and isolated browser baseline. | Existing failures are distinguished from new regressions; developer data is untouched. |

## Phase 1 — make the Brainstormer feel like a skilled collaborator

This establishes behavior used throughout the product. Stages 1–3 provide the first implementation checkpoint; the product milestone remains a complete nine-stage journey. Later specialists must be equally good at helping a person make their stage's decision without unnecessary document-editing work.

| ID | Work | Acceptance |
| --- | --- | --- |
| G01 | Define a shared specialist response contract separating conversational reply, current draft, open question, assumptions, and advisory readiness. Validate it at the supported boundary; retain readable fallback for malformed responses. | A short acknowledgement cannot silently replace the complete draft; malformed output does not fabricate question state or readiness. |
| G02 | Restore the adaptive interview: one important question at a time, optional likely answers, free text, and “not sure.” | Answering updates the understanding; corrections and unrelated comments do not automatically count as answers. Reload preserves the interview. |
| G03 | Refine Brainstormer behavior with scenario examples and evaluation criteria. | It explores who is affected, current behavior, concrete pain, desired outcome, and observable success; it challenges assumptions respectfully and avoids premature solution or stack selection. |
| G04 | Make questioning adaptive rather than a fixed questionnaire. | Known answers and supplied material are used; irrelevant questions disappear; a detailed brief can proceed without unnecessary interrogation. Consequential unknowns remain visible. |
| G05 | Separate the conversation from the evolving document. | The next question is prominent; the draft is easy to reveal, inspect, and correct; updates show what changed without dumping a complete document into every conversational turn. |
| G06 | Add advisory readiness grounded in the current draft and unresolved decisions. | “Ready to review” explains why; missing information is specific; required headings alone never establish readiness. Advisory findings remain distinct from actual approval requirements. |
| G07 | Build a durable context handoff using relevant approved versions, constraints, choices, source references, and unresolved assumptions. | Later stages preserve an early correction, named stack, data policy, and chosen approach; context is bounded and credentials are excluded. |
| G08 | Provide project guidance: where things stand, why attention is needed, and the recommended next action. | Guidance covers empty, working, waiting, failed, stale, reviewable, and completed states. Basic guidance works without inference; optional agent explanation cannot perform approvals or mutations. |

Dependencies: B02/B03 precede response persistence and context design. G01 supports G02/G05/G06; G07 supports all later stages. Do not encode a second stage machine to implement the interview.

Behavior scenarios: a four-word idea; a detailed brief; contradictory constraints; a supplied document containing the answer; “I don't know”; a mid-interview correction; an off-topic reply; a person naming a stack; an unavailable local provider; refresh and two-browser use. Expected behavior is defined per scenario before prompt changes are judged.

## Phase 2 — a uniform interface and trustworthy interaction

Deliver the foundations alongside Phase 1, then apply them to every surface.

| ID | Work | Acceptance |
| --- | --- | --- |
| U01 | Establish shared typography, spacing, widths, radii, color roles, controls, and action hierarchy using the existing component system. | Projects, Decisions, Settings, artifacts, and all stages use the same primitives; intentional exceptions are documented. |
| U02 | Standardize the workspace frame: stage purpose, current status, main work area, supporting context, and next action. | People can locate the main action consistently while design, audience, build, and delivery retain appropriate specialized layouts. |
| U03 | Unify conversation behavior, choice buttons, quotes, attachments, composer, scrolling, and submission feedback. | Keyboard submission and multiline entry are predictable; reading old messages does not force-scroll; failed sends retain text and support safe retry. |
| U04 | Standardize loading, empty, error, unavailable, permission, and stale states. | Every actionable failure offers a concrete recovery; unknown status is not success; elapsed time is distinguished from measured progress. |
| U05 | Make runtime visibility evidence-based. | Show real waiting/working/approval states; expose incremental text and tool output only if B02 establishes supported access. Stop pollers on unmount and avoid duplicated reads. |
| U06 | Complete responsive and accessible interaction. | Narrow layouts, keyboard navigation, focus restoration, labels, contrast, reduced motion, and screen-reader announcements are exercised on representative flows. |
| U07 | Polish copy and visual detail. | Consistent action names, agent identities, timestamps, document names, density, and restrained motion; no internal plumbing in ordinary user-facing copy. |

## Phase 3 — finish the nine-stage experience

| Stage / ID | Product work | Acceptance |
| --- | --- | --- |
| 1 / S01 | Guided problem discovery and visible, correctable assumptions. | A vague starting point becomes a useful approved brief through the Phase 1 interview. |
| 2 / S02 | Plain-language constraints guidance, including real data sources and operating environment. | The person understands consequential choices; the agent handles routine engineering choices and identifies unknowns without requesting secrets. |
| 3 / S03 | One or two approaches compared on the same criteria, with a clear recommendation and explicit selection. | Selection is recorded against the reviewed version and carried forward; choosing an approach cannot be confused with sending a chat answer. |
| 4 / S04 | Reliable mockup preview, empty/error states, anchored feedback, and revision comparison. | A real browser renders the artifact; feedback remains attached to the relevant version; addressed status requires explicit evidence, not merely a newer version. |
| 5 / S05 | Audience-specific packages, clear stakeholder decisions, and dependable presentation download. | People see who needs to decide, what is missing, and how to resolve a blocking response; exported content matches the reviewed package. |
| 5 / S06 | Reusable presentation templates and audience mapping. | First verify an actual template application path; upload, selection, unsupported-file feedback, and export are tested. Storing template bytes alone does not count. |
| 6 / S07 | Build plan grounded in the chosen approach, design, constraints, and concrete acceptance examples. | Requirements link to checks; dependencies and unresolved decisions are visible; the person can understand what will be built. |
| 7 / S08 | Clear target and cost review with assumptions and uncertainty. | Target choice is explicit; estimates separate inference, operating, and external service costs; unavailable measurements remain unknown. |
| 8 / S09 | Real build attempts, tool approvals, recorded outputs, failure recovery, and packaged evidence. | Commands and results come from execution evidence; continue and fresh-attempt behavior are distinct; a successful build has a retrievable archive and verified checks. Prompt instructions alone do not satisfy this. |
| 9 / S10 | Delivery review against the approved acceptance criteria and actual build. | Download and run instructions work; passed, failed, and unverified checks are distinct; acceptance, rejection, and revision have durable outcomes. Tool approval alone is not proof of successful delivery. |

## The complete guided journey: contracts for every stage

These are required product outcomes, not optional refinements. Each stage receives the relevant approved inputs and their provenance, preserves the person's corrections, explains its immediate purpose, and distinguishes advice from a human decision. An unanswered question, unavailable dependency, or failed operation leaves an explicit next action. No stage advances on an agent's assertion alone.

### Stage 1 — understand the problem

- **Guidance:** The Brainstormer helps identify who is affected, what happens today, the pain, and what success would look like. It asks the highest-value question first, accepts uncertainty, and avoids proposing a solution prematurely.
- **Experience:** A focused conversation with answer suggestions and free text; an evolving brief with inspectable assumptions and visible revisions.
- **Human decision:** Review and approve the problem brief, or correct it. Readiness advice explains unresolved questions without claiming authority to approve.
- **Handoff:** The approved brief, observable success criteria, relevant source material, and explicit assumptions reach stage 2.
- **Proof:** Start with a vague idea, correct an assumption, refresh, and finish with a brief that preserves the correction.

### Stage 2 — establish constraints

- **Guidance:** The constraints specialist identifies the intended form, audience, real data sources, privacy, integrations, environment, and non-goals. It explains consequences plainly and avoids re-asking answered questions.
- **Experience:** Guided consequential choices with clear distinctions between requirements, reasonable defaults, and unknowns. Credential setup uses secure supported surfaces, never chat.
- **Human decision:** Approve the constraints and any explicitly accepted uncertainty; unresolved prerequisites remain visible downstream.
- **Handoff:** Brief plus approved constraints, source availability, non-goals, and operational limitations reach stage 3.
- **Proof:** A named stack and sensitive-data restriction survive into the eventual build; missing real data is never silently replaced with purportedly real sample data.

### Stage 3 — choose an approach

- **Guidance:** The proposer presents one or two credible approaches, compares them against the same approved criteria, recommends one with reasons, and explains what would change that recommendation.
- **Experience:** A readable comparison and an explicit approach-selection action, with space to question or revise the options.
- **Human decision:** Select the approach against the exact reviewed version. A recommendation or casual conversational answer must not silently authorize the selection.
- **Handoff:** The selected approach, rationale, rejected alternatives where relevant, constraints, and success criteria reach stage 4.
- **Proof:** Ask for an option revision, select it, and verify later specialists build on that selection rather than the original recommendation.

### Stage 4 — shape the experience

- **Guidance:** The designer walks the person through important flows and states: first use, normal use, empty results, errors, permissions, and recovery. For a CLI or service, use appropriate interaction examples and contracts rather than forcing a visual mockup.
- **Experience:** A working preview or suitable interaction artifact, contextual feedback, version comparison, and explicit feedback disposition.
- **Human decision:** Approve the design and interaction criteria, or request specific changes. New versions do not automatically mean every comment was addressed.
- **Handoff:** Approved design, flows, states, and testable interaction criteria reach stage 5 and remain available to planning and building.
- **Proof:** Submit feedback on a real preview, inspect the revision, and trace the accepted change into the delivered result.

### Stage 5 — secure stakeholder alignment

- **Guidance:** The presentation specialist explains the proposal in each audience's language, highlights their relevant decisions and risks, and identifies whose input remains outstanding.
- **Experience:** Audience packages, preview and download, recorded decisions, and a clear summary of outstanding or blocking responses. A solo project follows the actual project policy without invented approvers.
- **Human decision:** Record stakeholder decisions under the configured authority and quorum requirements. Resolve blockers or explicitly return to the stage that must change.
- **Handoff:** Approved audience packages, recorded commitments, and accepted scope reach stage 6; material scope changes require review of affected earlier work.
- **Proof:** Exercise solo and multi-stakeholder projects, including a blocking response and its resolution; verify presentation export against reviewed content.

### Stage 6 — create an executable plan

- **Guidance:** The planning specialist translates the approved work into bounded tasks, dependencies, acceptance examples, and verification steps. It raises real contradictions and missing prerequisites while deciding routine implementation details.
- **Experience:** A navigable plan linking requirements to design and checks; clear scope, dependencies, and items requiring a human decision.
- **Human decision:** Approve what will be built and how completion will be checked, or revise the plan. No unexplained expansion of the agreed scope.
- **Handoff:** The versioned build plan, acceptance checklist, approved context, and unresolved prerequisites reach stage 7.
- **Proof:** Every material success criterion has a corresponding planned check; an earlier design correction appears in the build tasks.

### Stage 7 — approve target and cost

- **Guidance:** The estimator explains the intended target, operational prerequisites, estimated inference and operating costs, uncertainty, and what would require renewed approval.
- **Experience:** Clear target selection and a cost review distinguishing estimates, measured usage, external charges, and unknowns. Secure configuration exposes readiness without exposing values.
- **Human decision:** Approve the exact plan, selected target, and applicable cost constraints. Estimates are not presented as enforced budgets unless supported enforcement exists.
- **Handoff:** Approved plan and target, cost assumptions, applicable limits, and secure environment references reach stage 8.
- **Proof:** The builder uses the approved target; unavailable prerequisites are reported before dependent work; no credential enters an artifact or conversation.

### Stage 8 — build and verify

- **Guidance:** The builder explains meaningful progress and blockers, requests only necessary permissions or decisions, and distinguishes completed work from attempted or unverified work.
- **Experience:** Evidence-based activity, contextual tool approvals, recorded commands/results, failure details, and explicit continue versus new-attempt recovery. Fresh attempts retain prior directories and evidence.
- **Human decision:** Review requested tool permissions separately from the decision to accept build evidence and move to delivery review. A successful process exit is not sufficient build evidence.
- **Handoff:** A retrievable build archive, exact source/artifact provenance, test results, known limitations, and run instructions reach stage 9.
- **Proof:** Build a real product, encounter and recover from a failure, download its archive, and check it in a clean isolated environment against the approved plan.

### Stage 9 — deliver a usable result

- **Guidance:** The delivery verifier explains what was delivered, which original criteria have evidence, which remain failed or unverified, and how to use the result. It makes remaining human checks concrete.
- **Experience:** A delivery summary, criterion-by-criterion evidence, working downloads, setup/run instructions, limitations, and explicit accept or request-changes actions.
- **Human decision:** Accept the verified delivery or send it back with a reason and a defined revision destination. Permission to invoke a delivery tool is distinct from evidence that its operation succeeded.
- **Handoff:** A durable accepted delivery record tied to exact artifacts and evidence, accessible from the project overview after restart. Revisions preserve earlier deliveries and invalidate affected downstream reviews.
- **Proof:** A person follows the supplied instructions from the downloaded result, exercises the promised workflow, and can inspect the acceptance record. Also exercise rejection, stage 8 revision, renewed verification, and final acceptance.

## Phase 4 — decisions, revision, and recovery

| ID | Work | Acceptance |
| --- | --- | --- |
| R01 | Decision queue hygiene and actionable project context. | Released or otherwise non-actionable requests do not appear as pending actions; valid live approvals survive reload/restart. Resolve run versus anchor identity using actual types. |
| R02 | Consistent approval presentation and review provenance. | Workspace and queue show the same request, reviewed version, consequences, decision, and time; duplicate actions settle predictably. |
| R03 | Design send-back and downstream invalidation before implementing it. | Specify durable intent, invalidated versions, outstanding approvals, agent context, retries, partial failure, and concurrent actions. A send-back to 3 cannot accidentally retain actionable downstream approval. |
| R04 | Implement send-back with a clear impact preview and reason. | Earlier evidence remains inspectable; the target specialist receives the reason once; later work is visibly stale until reviewed again. No destructive cleanup. |
| R05 | Draft/version history and restoration. | Versions have stable provenance; comparison uses the requested version's content; a refresh retains draft and review context. Restoration creates explicit history rather than silently rewriting an approval. |
| R06 | Recovery across refresh, restart, provider failure, delayed mail, and two browsers. | No duplicate opening messages, duplicate approvals, lost edits, wrong-project state, or silent advancement. Unsupported cancellation is not presented as an operative control. |
| R07 | Notification and deep-link consistency. | Notifications lead to the exact project/request; delivery status is evidence-backed and missing sent-mail evidence is not automatically labeled failure. |

R03 depends on the architecture/API audit and version contracts. R01 can ship independently and early. Keep each defect separate when creating issues and PRs.

## Phase 5 — overview, settings, and improvements beyond parity

| ID | Work | Acceptance |
| --- | --- | --- |
| P01 | Projects overview organized around attention and next actions. | Each project shows meaningful status, current stage, blocking decision, and a useful return path. |
| P02 | Measured usage and cost visibility. | Report only supported measurements; distinguish observed usage from estimated cost and unknown attribution. Avoid per-project polling storms. |
| P03 | Consistent onboarding and Settings. | A person can understand provider readiness, model choice, unavailable local service, and the effect of settings on existing versus new specialists. |
| P04 | A decision trail connecting the original problem to the delivered result. | People can inspect why an approach was chosen, what changed, and which evidence supports the final outcome. |
| P05 | A useful return-to-project summary. | After time away, the person sees what changed, what is waiting, and the next action without rereading the transcript. |
| P06 | Better defaults through observed friction. | Record time to useful question, repeated questions, unanswered blockers, failed retries, and delivery completion in isolated evaluations; use these to prioritize refinements. Any product telemetry requires a separate privacy design. |

## Delivery sequence and proof

Apply the parity-first classification above to every step. The sequence is implementation order, not permission to expand scope beyond main before the complete parity journey works. Phase 5's beyond-parity proposals and any novel behavior elsewhere remain a separate enhancement backlog.

1. Establish B01–B04 and a visual reference; fix R01 early if confirmed.
2. Establish the all-stage guidance, context, version, and UI contracts, including send-back design. Use stages 1–3 as an implementation checkpoint, while evaluating all nine stage transitions from the outset.
3. Complete design and stakeholder review: S04–S06, accessible shared interactions, draft history, and continuity into the build plan.
4. Complete plan-to-delivery: S07–S10 and evidence-based runtime visibility. Run a real project through all nine stages; this is the first complete product milestone.
5. Prove the complete journey under revision and failure: send-back, reapproval, failed build recovery, restart, concurrent browsers, and delivery rejection followed by successful revision.
6. Finish overview, Settings, usage, responsive coverage, and improvements beyond parity. Compare the full experience with main, including every stage's guidance and visual consistency.

End-to-end acceptance is mandatory: opening idea → approved brief → constraints → selected approach → approved design → stakeholder alignment → executable plan → target/cost approval → built and checked artifact → usable, accepted delivery. No checkpoint consisting only of prompts, early stages, screenshots, or an archive file satisfies the objective. Required evidence includes actually using the resulting product and retaining its decision history across restart.

Each implementation runs `bun run check` before claiming success. UI work also requires driving the mounted app; fixtures and screenshots alone are insufficient. New in-process smokes import `scripts/smoke-env.ts` first. Use isolated data and keep prior attempt directories.

Evaluate behavior using repeatable scenarios and recorded transcripts, not exact-string prompt assertions alone. Use deterministic tests for contracts, provenance, state projection, retries, and invalidation. Compare representative connected models without claiming equal performance across all models. Agree numerical latency and quality targets after the baseline is measured.

Release evidence includes a stage 1–3 interview, a full nine-stage project, a real download/run check, send-back and reapproval, a failed build and recovery, local-provider unavailability, a restart, two browsers on one project, and keyboard/narrow-screen use. Gate passage and product quality are assessed separately.

## Turning this into Linear later

Use phases as milestones and the local IDs as candidate issue titles. Split rows containing multiple independently shippable changes; one defect per issue and one PR per issue. Each ticket should carry: the person's problem, observed baseline, intended behavior, implementation boundary, dependencies, acceptance scenario, and verification evidence. B02 investigations may produce explicit upstream dependency tickets rather than local substitutes.

This plan does not copy main's host routes, promise unsupported streaming/spend, restore a retired lifecycle, or require an additional agent for every UI decision. It restores and improves the guided product experience through the architecture already chosen.
