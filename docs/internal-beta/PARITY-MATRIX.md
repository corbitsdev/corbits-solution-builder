# Internal-beta experience parity matrix

**Pinned reference:** `origin/main` `e39e8513ed21a2859b1111b5c390550e98c51ead` (2026-09-18).
**Audited beta head:** `f96eb557bb7409c700c06364c7b44fcc3bdf6692` (2026-09-19).

This is source-inspection evidence, not a claim that either revision was driven in
a browser. I inspected main and beta workspace, shell, project, decisions,
settings, design, audiences, client, mail, artifact and build/delivery sources.

## Observation boundary

| Evidence | Result |
| --- | --- |
| Browser tool | `agent-browser` exists at `/opt/homebrew/bin/agent-browser`. |
| Isolated browser/runtime | Not observed by this lane. `bun run ui:build` failed before a host/browser launch because Vite could not resolve `@corbits/react-ui`. No host or data directory was started or used. |
| Build side effect | The closure packer ran before Vite failed; its generated output is ignored. This lane made no application-code edits. |

Every item below is source-inspected unless a later runtime verification says
otherwise. Acceptance statements are required future proof, not current passes.

## Release-blocking process discrepancy

Current `StageWorkspace.approve()` calls `persistStageDraft` /
`persistBuildEvidence`, optimistically increments local `stageFloor`, and
sends the next-stage opening. `currentStageFromArtifacts` reconstructs the
cursor from `sb.approvedAt`. Therefore the browser presently owns stages
1--8 progression. The selected native tracker design requires UI intent plus
committed-state rendering, never browser authority to approve/advance. This is
a correctness blocker across those stages, not just a visual mismatch.

## Nine-stage matrix

| Stage | Main source behavior | Current beta source behavior | Status and acceptance |
| --- | --- | --- | --- |
| 1 Problem | Lifecycle draft/reply, streamed text, evaluator advisory gate, adaptive question state, document revisions and approval. | Single-step mail; complete-reply polling; `StageDocument` gets `openQuestion={null}`, no evaluation, `live={null}`; latest reply becomes draft. | **Regressed/blocked.** Correct an assumption, refresh, see it preserved; show truthful readiness; commit a version/hash-bound review before advance. |
| 2 Constraints | Guided draft/revision/review with lifecycle context. | Mail document; only prior approved document is automatically forwarded, without bounded structured context/provenance. | **Partial.** Approve source/privacy/environment/integration/non-goal evidence and prove a named restriction/unknown reaches later work. |
| 3 Approach | Comparable alternatives and an explicit version-bound selection/review. | Sections can render approaches, but ordinary approval authorizes latest reply; no selection record. | **Regressed/blocked.** Select a reviewed version/hash, revise it, and prove design uses selected—not merely recommended—option. |
| 4 Design | Sandboxed preview, anchors, feedback history/revision. | Preview, anchors and feedback artifacts/mail remain; disposition and prompt digest were removed. Preview is not runtime-verified. | **Partial.** Real-browser preview; feedback remains attached to referenced version and gets explicit disposition evidence after revision. |
| 5 Alignment | Audience packages, stakeholder/quorum gate, deck export/template settings, revision path. | Audience authoring, stakeholder decisions and client-side slide generation; shared gate/quorum and template mapping absent. | **Partial/blocked.** Exercise solo and multi-stakeholder policy, a blocker and resolution, and a reviewed deck download; native workflow validates policy. |
| 6 Plan | Requirements/review companions and lifecycle review/context. | Mail document plus optional companion artifacts; no demonstrated structured approved-context handoff. | **Partial.** Every material criterion maps to a plan check; stage-4 correction makes downstream plan stale and requires renewed review. |
| 7 Cost/target | Cost approval/freeze and packet summary, distinct decision semantics. | Parsed estimate + locally required target radio; target is written by client artifact call and prepended to mail. | **Partial/blocked.** Tracker commits exact plan/target/cost scope; UI distinguishes estimate, measured value and unknown; no secret shown. |
| 8 Build | Observed attempt state/output/exit/stderr/archive/counts; distinct continue vs fresh retry. | Mail agent, tool-approval/event/reply timeline, elapsed clock, archive when present; mail prompts for start/cancel/accept/fail; no observed output/exit/stderr or retry semantics. | **Regressed.** Real isolated build has evidence-backed commands/results and archive; permission is separate from evidence acceptance; prove continue and fresh-attempt recovery. |
| 9 Delivery | Manifest/verification, accept/reject/revise, notification evidence and send-back. | Inline stock deliver approval, manifest paths/hashes, archive/instructions; reject only sends tool feedback; accepted banner is localStorage-cached; no send-back/durable acceptance record. | **Regressed/blocked.** Download/run delivery, distinguish passed/failed/unverified checks, durable accept by manifest/hash, reject-to-8, reverify, accept. |

## Support-screen matrix

| Surface | Main behavior | Current beta source | Status / acceptance |
| --- | --- | --- | --- |
| Workspace/guidance | Shared frame, artifact rail, meaningful “where does this stand?” guidance/next action. | Frame/artifact tab remain; `api.guidance` projection is gone. | **Partial.** Empty, working, waiting, failed, stale, reviewable, delivered each have one evidence-backed next action. |
| Conversation/document | Two panes, quotes, attachments, diffs, pending, stop/amend and live draft. | Two panes/quotes/diff remain; no stop, structured questions, live text or durable draft-turn association. | **Partial.** Keyboard, multiline, retry and scroll behavior work; only real mail/run evidence indicates activity. |
| Decision queue | Same version/hash decision in workspace and queue; approve/reject/revise/send-back. | Stock tool approvals mapped to projects; only delivery is a business decision. | **Regressed.** Stale/duplicate/late/wrong-project/released-run requests are non-actionable and explain recovery. |
| Projects/spend | Project overview plus spend summary/card totals. | Projects/cards/artifact counts remain; spend readout absent. | **Partial.** Show supported measured cost, truthful turns/duration, or unknown—never inferred cost. |
| Settings/providers/templates | Provider management and deck template upload/mapping/remove. | Provider/onboarding remain; templates/mapping removed. | **Partial.** Safe provider recovery; prove template affects exported deck, otherwise retain explicit gap. |
| Build/delivery recovery | Attempt state, retry/routing and evidence. | Timeline/instructions/download exist but recovery is mail prompting, not authoritative. | **Regressed.** Unsupported controls say unavailable; test restart, delayed mail, failed action, two browsers, fresh/continue. |
| Notifications/artifacts/print | Decision delivery evidence, inspection and print continuity. | Bell, artifact graph and print remain; delivery notification outcome not shown. | **Partial.** Deep-link exact project/decision; absent mail evidence is unknown, not failure. |

## Main UI behaviors to reuse (presentation only)

1. Two-pane document/conversation: quotes, versions/diff, recoverable composer.
2. Advisory stage gate: readiness, quorum and next action projected from committed state; never a transition authority.
3. Purpose-specific panels: design feedback, audience/deck, target/cost, build evidence and delivery verification.
4. Build hierarchy separating observed output, terminal result, archive and recovery choice.
5. Workspace/queue views of one exact review identity/version/hash/timestamp.
6. Send-back impact picker with retained history, never destructive rewrite.
7. Projects, spend, guidance and notification affordances only where supported reads exist.

## Recommended disjoint UI lanes

Start only after the tracker contract provides a read model and intents for:
committed project state; review ID/version/hash; decision result; staleness; and
actionability. UI must not write `approvedAt` or infer the cursor.

| Lane | Exclusive ownership | Contract dependency |
| --- | --- | --- |
| Workspace core | `workspace/index.tsx`, `document.tsx`, `thread.tsx`, `preparing.tsx`, `gate.tsx`; stages 1--3 and 6--7. | Tracker projection/intents; return reusable status/next-action UI. |
| Design + alignment | `design.tsx`, `audiences.tsx`, template/settings subcomponents and local CSS. | Versioned feedback plus policy/quorum projection; prove stages 4--5. |
| Build + delivery | `workspace/build.tsx`, `delivery.tsx`, local CSS. | Native execution evidence and recovery/decision projections; prove 8--9 without simulated cancellation/streaming. |
| Shell/support | `app.tsx`, projects, decisions, settings, notification/guidance/spend presentation. | Read-only projections; no tracker mutation semantics. |
| Integration owner | `client.ts`, projection/read adapters, `project-view.ts`, `decisions-fold.ts`, app state wiring. | Serializes contract changes; other UI lanes do not edit these files concurrently. |

Avoid concurrent free-for-all edits to `styles.css`; assign CSS with its owning
component. Verification sequence: regain buildable isolated app; walk 1→3;
exercise every specialist panel; then full 1→9 plus send-back/restart/two-browser
recovery with the process provisioner. `bun run check` is the gate, not proof
of visual/process parity.

