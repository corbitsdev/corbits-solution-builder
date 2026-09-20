# Handoff: bring internal-beta to parity with main (and past it) without regressions

Repo: corbitsdev/solutions-builder-alpha. Working branch: `internal-beta` (head f96eb557, 2026-09-19 17:00Z). Never touch `main`. Never touch `vendor/interchange` (faremeter/interchange at the pin workbench uses; see `VENDORED.md`). Reference implementations: `origin/main` for the old UX (`git show origin/main:<path>`), corbitsdev/workbench for the runtime shape (`gh api repos/corbitsdev/workbench/contents/<path>` or a clone).

This document has four parts: (1) the architecture you must preserve, with the exact data surfaces the client has; (2) how to run and verify; (3) the gap list versus main, item by item, with data source, algorithm, files, acceptance test and regression risk; (4) known open bugs and model/prompt facts.

---

## 1. Architecture you must preserve

### 1.1 Hub is the whole backend
- `apps/hub/src` is an embedding allow-list (server, hub-mount, hub-keys, hub-migrate, db, paths, host-secrets, sidecar-processes, api-host, lifecycle). No product routes, no host database, no folds. Do not add any. `scripts/check-boundaries.ts` enforces the file list.
- The vendored Interchange hub is mounted in-process on pglite (`SOLUTIONS_BUILDER_DATA_DIR/hub/pglite`). Product capabilities are corbitsdev packages mounted in `packages/embed-hub/src/index.ts`:
  - `@corbits/artifacts` at `/api/tenants/:tenantId/artifacts` (create `POST` `{mode:"text", title, content, metadata}`, get `GET /artifacts/:id` returns `{artifact:{id, kind, title, version, content, metadata, createdAt, ...}}`, list `GET /artifacts?limit=100&cursor=`, revise via installer `reviseArtifact`).
  - `@corbits/mailbox` at `/api/tenants/:tenantId/mailbox/me/inbox` (`?folder=INBOX|Sent&limit=100` → `{messages:[{uid, envelope:{messageId, from, to[], subject, date, inReplyTo}, raw(base64 RFC5322)}]}`) and `.../inbox/send` (`{to:[addr], subject?, body, inReplyTo?}`). Two-way wiring: `createMailboxDeliver` routes mail addressed to a run into the hub trigger path; `createMailboxPersist` (with the ported session-ensure + `authorizeSender`) lands agent replies in principal inboxes. Person-to-person send now authorised (#442).
  - Legacy un-scoped `/api/me/inbox` (+ `/events` SSE) still mounted; used only by the notifications bell (`apps/web/src/inbox.ts`).
  - `@corbits/react-ui` for the shell/components; `@corbits/oauth-core` + codex/xai for OAuth providers.
- Host loopback door: every `/api/*` request needs the `solutions_builder_session` cookie set by the launch URL `?token=<uuid>` (printed at boot). The token is persisted in the host secret store since #435, so it is stable across restarts. Unauthenticated `/api/status` returns 401; the web app routes that to sign-in (#434).

### 1.2 Stage machine = artifacts
- `apps/web/src/project-view.ts` `currentStageFromArtifacts(nodes)`: stage = 1 + highest N such that a node with `stage===N && kind===STAGE_DRAFT_KIND[N] && supersededByNodeId===null && approvedAt!==null` exists (capped at 9).
- `STAGE_DRAFT_KIND` (apps/web/src/client.ts:58): 1 problem_brief, 2 solution_constraints, 3 chosen_approach, 4 design_artifact, 5 audience_package, 6 build_plan, 7 cost_approval, 8 build_evidence, 9 delivery_manifest.
- `sb` metadata contract (packages/solutions-builder/src/artifact-graph.ts): `{projectId, kind, stage, mediaType, variant?, sourceVersionIds[], provenance:{producer:"agent"|"person", agentRole?, model?}, supersedes?, approvedAt? (ONLY the Approve path), target? (stage 7 chosen target), decisions?[] (stage 5, per stakeholder), feedback?[] (stage 4)}`. Artifacts are written to the WORKSPACE tenant and scoped by `sb.projectId`.
- Writers today: `persistStageDraft` (Approve; stamps approvedAt), `persistAudiencePackage` (stage 5 "Write it"), `persistBuildEvidence` (stage 8 Approve when the reply carries a `publish_workspace` result), `recordAudienceDecision` (revise `sb.decisions`), `submitDesignFeedback` (revise `sb.feedback` + mail), `attachMaterial` (source_material), `createProject` (opening `source_material` variant `__opening__`). Any new writer must not stamp `approvedAt`.
- `ArtifactNode` (client.ts:264): `{id, kind, variant, stage, title, version, artifactId, contentHash ("<id>@<version>"), sizeBytes (always 0 — known), mediaType?, createdAt, supersededByNodeId, provenance, approvedAt}`. Content via `api.artifactContent(tenantId, nodeId)`.

### 1.3 Specialists = single-step mail agents (workbench shape)
- `api.ensureStageAgent(projectId, stage)` → `ensureSpecialistDeployment` (packages/installer/src/specialist-deploy.ts): asset `sb-project-<projectId with _ → ->-stage-<N>` (kind workflow) in the workspace tenant; source rendered by `specialistEntrySource` (packages/solutions-builder/src/specialist-source.ts): `defineWorkflow({id:"sb-stage-<N>", triggers:[{type:"mail", to}], steps:{run:{kind:"step", triggers:"unbounded", drainBehavior:"wait", input:{from:"trigger.payload"}, agent:{systemPrompt, tools, inference:{sources:[SOURCE]}}}}})`; tools: stage 5 `deck`, stage 8 `posix` + `publishWorkspace`, stage 9 `delivery, deliver`; pushed by git (`pushWorkflowSourceTree`, token minted with a random suffix and revoked after; `waitForPushVisible` before deploy, #440), deployed with `POST /api/tenants/:t/workflows/deployments {source:{kind:"asset", assetId, package:{format:"source", commitSha, packageName:assetName}}, entry:"./workflow.js", sourceOfferingIds, defaultSourceOfferingId}`. Run address `<deploymentId>@<tenant.domain>`. `pickDeployment` prefers live (not released/releasing/ended) then oldest; the client memoises per `project:stage` and re-resolves when the live pick changes (#433, #437).
- Model: the workspace's first offering; Settings → Inference → "Model for <provider>" (`PUT providers/:id/model` equivalent via catalog). Existing deployments keep the model they were rendered with; new stage agents pick up the new choice.
- Conversation: `apps/web/src/stage-mail.ts` `sendStageMail(tenantId, address, {body, inReplyTo?})`, `readStageThread(tenantId, [addresses]) → ChatMessage[{id:"INBOX:<uid>"|"Sent:<uid>", author:"agent"|"me", body (first text/plain part), at, inReplyTo?}]`. Polled every 3 s in `StageWorkspace`.
- Opening mail: stage 1 sends the project's opening statement (`api.projectOpening`); stage N>1 sends the approved text from stage N-1 (from `approve()`'s `pendingOpening`, or the CL-8644 fallback reading the previous stage's approved artifact); once per `project:stage:address` (#439); guarded by `agent.stage === stage` (#432).
- Tool gates: stock hub approvals. `GET /api/tenants/<workspace>/approvals` (pending only) → `{data:[{id, runId, anchorRunId, agentAddress, toolDefinition:{name}, toolArguments, status, createdAt, resolvedAt}]}`; `POST /approvals/:id/approve {scope:"once"}`, `POST /approvals/:id/reject {message}`; `GET /approvals/:id` works for resolved ones. Both approve and reject return 409 for a run whose deployment was released. Project mapping = `listSpecialistDeployments(transport, workspaceTenantId, projectId)` → `{stage, deploymentId}[]` (packages/installer). Decision queue fold: `apps/web/src/decisions-fold.ts`, `project-list.ts`, `pending-approvals.ts` (`approveTool`, `rejectTool`, `approvalById`).
- Run introspection: `GET /api/tenants/<ws>/workflows/deployments` (`{id, definitionName, status: deployed|pending|releasing|released|…, createdAt, endedAt}`), `GET /api/tenants/<ws>/workflows/runs/<runId>` and `.../events` (`{events:[{seq, type: RunStarted|StepStarted|SignalAwaited{parkKind: approval|input}|SignalReceived{payload.outcome}|…, body.at}]}`). Polling only; no SSE on these.
- Inference records the hub keeps (vendor/interchange/packages/db/src/schema/messages.ts): `inference_turn {id, sessionId, runId, tenantId, model, status, startedAt, endedAt}` and `turn_part {turnId, …}` (text / tool parts). `wallets.ts`: `wallet`, `transaction`. Check `hub-api/src/routes/*.ts` for which of these have tenant GET routes before designing spend or streaming; `runs.ts` has ~10 tenant GETs (list/inspect them). There is no `text/event-stream` route in hub-api apart from the mailbox `/events`.

### 1.4 Web app structure (apps/web/src)
- Shell `App.tsx`/`app.tsx` (sidebar, Projects, Decision queue, Settings, notifications bell, `refresh()` boot/auth routing, `key={detail.project.id}` on `StageWorkspace`).
- `pages/workspace/index.tsx` `StageWorkspace`: agent identity `{stage,address}`, thread poll, `stageAgentStatus` poll, opening effect, `approve()`, per-stage render: stages 1,2,3,6,7 → `StageDocument` (document.tsx) with `Preparing` before the first reply; 4 → `DesignPanel` (pages/design.tsx); 5 → `AudiencePackages` (pages/audiences.tsx, has its own Approve); 7 also `TargetPicker` (freeze.tsx) + `EstimateView` (estimate.tsx); 8 → `BuildPanel` (build.tsx: mail buttons, timeline, Approve); 9 → `DeliveryPanel` (delivery.tsx) + markdown fallback + `StageConversation` (thread.tsx). `gate.tsx` `StageGate` exists but is not lit (no verdict producer).
- Client: `client.ts` (`api.*` listed in 1.2/1.3 plus `projects`, `projectView`, `decisions`, `providers`, `connectProvider`, `selectProviderModel`, `stakeholders`, `saveSlidesFor`, `designerSettings`, `artifactGraph`, `preferences`), `project-view.ts`, `artifact-graph.ts`, `decisions-fold.ts`, `decision-notify.ts` (tenant mailbox, marker `[decision:<id>]`), `revisions.ts` (diff), `first-run.ts` (boot/auth/onboarding routing).
- CSS: `styles.css` with tokens `--radius: 8px`, `--radius-lg: 12px` (only these two, #447); classes from main are mostly still present (`.document-layout`, `.stage-thread`, `.composer*`, `.preparing*`, `.live-output`, `.stage-gate`, `.approaches`, `.spend-*`); removed from main: `.send-back*`, `.turn-withdrawn*`, `.deck-role*`, `.deck-template*`, `.roll*`, `.project-info-spend`.

### 1.5 Kit (packages/solutions-builder/src)
- Roles (kit.ts): brainstormer (1), constraints-mapper (2), proposer (3), experience-designer (4), presentation-creator (5), requirements-author + architect (6), estimator (7), build-engineer (8, #443), delivery-verifier (9), plus product-guide, namer, brief-evaluator (unused now), senior-engineer-* panel. `SHARED_RULES` leads with the control-plane rule (#446): build what was asked; Interchange is the control plane for tenancy/principals/auth/durability; product tables live in their own Postgres schema FK'd to `tenant.id`/`principal.id`; agents/workflows only where the brief needs them. Required headings per stage are fixed (e.g. stage 1: In short, Problem statement, Who is affected, What happens today, What a fix would be worth, Success criteria, What I assumed, What I need from you; stage 3: Approach A/B, Side by side, Recommendation, What I need from you; stage 8: Commands run and output, File tree, What works right now, What is left, What I need from a human). `scripts/kit-smoke.ts` checks role ids/headings.
- Skills (seed-kit.ts, platform-skills/*.md) are reference material now, not mandates (#446).

---

## 2. Run and verify

- Fresh worktree: `git worktree add ../cl-<n>-<slug> -b cl-<n>-<slug> origin/internal-beta && bun install`. Gates: `bun run typecheck`, `bun run ui:build` (web), `bun run scripts/kit-smoke.ts` (kit). No CI wait. Conventional Commits, GPG-signed, no AI attribution anywhere, PR to internal-beta, squash-merge.
- Host: from a checkout, `SOLUTIONS_BUILDER_DATA_DIR=<dir> bun --conditions intx-src apps/hub/src/server.ts --port 4880`; it serves `apps/web/dist` from disk (rebuild = `bun run ui:build`, reload the tab; restart only for hub/installer/kit/tools changes). Boot prints the launch URL. Data dir persists accounts, projects, deployments; keep >10 GB free (a full disk hangs sidecars silently; the hub's 5-minute dispatch backstop then logs `waitForRunTerminalOrPark backstop`).
- Browser walk: `scratchpad/drive-project.sh <agent-browser session> <problem.txt> <log>` (this session's scratchpad; copy it into `scripts/` if useful) drives create → 9 stages via agent-browser: fills the composer, clicks the panel "Approve and continue" (stages 4/5/8 have their own; stage 7 needs a target radio first), presses "Write it" + "Proceed" at 5, approves tool calls in the Decision queue (filters cards by `PROJECT: <title>`), nudges stage 9 to call `deliver`, and logs `BUG`/`TIMEOUT` lines with screenshots. Env: `RESUME_STAGE`, `END_STAGE`, `SKIP_START`, `SEND_BRIEF_NOW`, `BUILD_BRIEF`, `BUILD_CONTINUE`, `BUILD_IDLE`, `TARGET_PREF`, `STAGE_TIMEOUT`. Verify every UI PR with at least stages 1→3 and the stage the PR touches. Sign-in helper: open the launch URL, then `Sign in` (throwaway account in this data dir: sawyer@abklabs.com / [REDACTED]).
- Truth checks when the UI is ambiguous: mailbox listing (`/mailbox/me/inbox?folder=Sent|INBOX`), run events, approvals list, artifacts list — all reachable from the browser console with the session cookie.

---

## 3. Gaps versus main, by priority

> **Superseded in part (2026-09-19).** `PLAN-internal-beta-experience.md` makes the native project workflow the process authority. The build recipes in 3.3 (client nulls `approvedAt`), 3.5 ("from scratch" = `rm -rf ./*`) and 3.8 (reject → client send-back) contradict it and must not be implemented as written. The observed main behaviour in each item still stands as the spec; see the plan's "Parity gap inventory" for the replacement path.

Each item: what main had (file:line on origin/main), what internal-beta has, data now available, how to build it, files, acceptance, regression risk.

### 3.1 Live drafting text and live tool output
- Main: host SSE `/api/projects/:id/stages/:stage/live` streamed the draft into `Preparing.liveDraft` and the document; `/build/live` streamed worker stdout into `LiveOutput` with an elapsed clock (index.tsx 484, 1243-1294 on main).
- Now: complete replies only, 10-60 s after send; stage 8 shows commands (from approvals) and states (from run events) but no output until the agent's report.
- Data: no SSE. Candidates: (a) hub routes over `inference_turn`/`turn_part` for the run's session (check `routes/runs.ts` tenant GETs and any `sessions`/`messages` route in `hub-api/src`); (b) run events (state only); (c) the mailbox `/events` SSE fires when a reply lands (use it to end the "working" state promptly instead of the 3 s poll).
- Build: `apps/web/src/live-turn.ts` `useLiveTurn(tenantId, deploymentId)` → `{text, toolCalls:[{name,args,output?,status}], working}` polling 2 s while `working` (derive `working` from run events: last event StepStarted/SignalReceived without a later SignalAwaited:input) and reading turn parts if a route exists. Render: `Preparing` (`liveDraft`), `StageDocument` conversation pane (streaming bubble), `build.tsx` rows (`output` snippet). Stop polling when the mail reply arrives.
- Acceptance: at stage 1 the draft text appears incrementally (or, if the hub exposes no text, the panel shows "working · Ns" with the elapsed clock and switches to the reply within 3 s of arrival); at stage 8 each approved command shows its exit/output once the agent's turn continues.
- Risk: poll storms — one poller per mounted workspace, cleared on unmount/address change; never poll a released deployment.

### 3.2 Stage 1 readiness verdict (StageGate)
- Main: brief-evaluator agent inside the lifecycle wrote `evaluation` on `api.thread()`; `gate.tsx:33-88` lit ready/needs-input with a "still missing" list; composer showed an "is-ready" state.
- Now: `gate.tsx` present, unmounted; `brief-evaluator` role still in kit.ts.
- Build A (no agent): `pages/workspace/readiness.ts` `readiness(stage, replyBody) → {ready, missing:[headings], openQuestions:[...]}`: required headings per stage from kit.ts; `ready` when all present and "What I need from you" has no bullets or says none. Mount `StageGate` in `StageDocument`'s header for stages 1,2,3,6,7 and disable nothing (Approve stays available; the gate is advice).
- Build B (agent): deploy `sb-project-<id>-evaluator` with the `brief-evaluator` prompt via the same `ensureSpecialistDeployment` (add a pseudo-stage id, e.g. 101, to `specialistAssetName`/`stageOfStepId`), mail it the draft after each specialist reply, parse `## Verdict`. Only if A proves too weak.
- Acceptance: stage 1 first reply with open questions → gate "needs input" listing them; after the person answers and the specialist's next reply has none → "ready".
- Risk: heading drift between kit prompts and the checker — import the heading lists from a shared module in packages/solutions-builder (export from kit.ts) rather than duplicating.

### 3.3 Send-back to an earlier stage
- Main: `pages/send-back.tsx` + `decision.sendBack` command; `index.tsx:417-447` folded a send-back `details` block.
- Now: nothing; reject in the queue carries only a message.
- Build: `api.sendBackToStage(projectId, targetStage, reason)`: for every node with `stage >= targetStage && approvedAt !== null && supersededByNodeId === null`, `reviseArtifact` its metadata to `approvedAt: null` (keep content; the fold then returns the cursor to `targetStage`); `ensureStageAgent(projectId, targetStage)`; `sendStageMail` "Sent back from stage N: <reason>". UI: header menu "Send back…" (stage picker 1..stage-1 + reason), and the Decision queue reject dialog gets a "send back to stage" option for stage 8/9 decisions. Restore main's `send-back.tsx` markup and `.send-back*` CSS.
- Acceptance: at stage 6 send back to 3 → workspace shows stage 3, the stage 3 agent receives the reason mail and replies, later Approve at 3 re-stamps and the cursor moves to 4 (stages 4-5 artifacts re-approve on their own Approves).
- Risk: `reviseArtifact` semantics in @corbits/artifacts — confirm it creates a new version in place and that `toArtifactNode` reads `approvedAt` from the latest version; add the `supersedes` link if revise creates a new id.

### 3.4 Spend readout
- Main: `api.spend()` → `.spend-box/.spend-figure/.spend-caption/.spend-providers` on Projects (`projects.tsx:483-500`), `.project-info-spend/.project-info-total` on cards.
- Now: nothing. CSS `.spend-*` present.
- Data: `inference_turn` rows per run (model, times) and whatever token/cost columns `turn_part`/`transaction` carry; find the tenant GET in `hub-api/src/routes` (runs.ts / wallets.ts). If no route exposes tokens, show turn counts and durations per model.
- Build: `apps/web/src/spend.ts` `spendFor(workspaceTenantId, projects)` grouping by project (deployment ids from `listSpecialistDeployments`) and model; render on Projects and in the workspace header ("Inference so far: N turns · M tokens").
- Acceptance: after a 1→9 walk the Projects page shows a non-zero figure that increases with each stage.
- Risk: N+1 calls — fetch once per page load, cache 30 s.

### 3.5 Stage 8 detail
- Main: exit status, workspace path, packaged archive row with Save (`BuildArchiveRow`), turns/tool-calls counts, stderr tail, live output, "Try again continuing from this attempt" vs "from scratch" (main index.tsx 851-1294).
- Now: `build.tsx` timeline (approval rows with command/status/time, run-event state label, elapsed clock, packaged build download when a `.tar.gz` `build_evidence` exists), four mail buttons, Approve.
- Build: tool outputs from 3.1; "Retry from scratch" = mail "Start over in a fresh directory: `rm -rf ./*` then rebuild", "Continue" = mail "Continue from the current workspace"; counts = number of approvals + replies. Make `publish_workspace` mandatory at the end of a successful build (kit.ts build-engineer prompt) so the tarball always exists; `approve()` already persists it (`persistBuildEvidence`).
- Acceptance: after a real build, the panel shows N commands, the tarball with a working download, and the final report; Approve carries the tarball to stage 9's "What was built".
- Risk: the builder pauses to ask environment questions unless the opening brief pre-answers env/tenant/DB (observed with gpt-oss:20b); consider a stage 8 "environment card" (DB URL, tenant id, HUB_URL) the person fills once and the client prepends to the opening mail.

### 3.6 Stage 4 mockups and feedback detail
- Main: `DesignFeedbackView` iframe (`design.tsx:270`, `srcDoc`, `sandbox=""`), anchored comments, feedback table with Disposition column, `prompt <hash>` label.
- Now: iframe + anchors + tables kept; Disposition column and prompt hash dropped; the iframe was blank in headless capture (CL-8634) — unverified in a real browser.
- Build: verify in a real browser first; if blank, check that the design artifact content is HTML and that `srcDoc` receives it (not the markdown notes). Restore Disposition (fold from `sb.feedback[].disposition`, set when the designer's next reply addresses it — parse "Addressed: …" lines or mark on new version) and the prompt hash label (`design-prompt` hash).
- Acceptance: stage 4 shows a rendered mockup; a click adds an anchored comment; submitting mails the designer; the next version marks the comment addressed.

### 3.7 Deck templates in Settings
- Main: `settings.tsx:632-720` upload/remove `.pptx` templates and role→template mapping via host endpoints; `.deck-role*`, `.deck-template*` CSS.
- Now: gone; deck built client-side by `saveSlidesFor` from the stage 5 outline.
- Build: templates as artifacts (`sb.kind:"deck_template"`, `mediaType: application/vnd.openxmlformats-officedocument.presentationml.presentation`, binary via the same mode the `.tar.gz` uses); Settings UI restored from main; `saveSlidesFor` takes the selected template's bytes. Role mapping stored in project policy or a `sb.kind:"deck_settings"` artifact.
- Acceptance: upload a template, save slides at stage 5, the pptx uses it.

### 3.8 Stage 9 completeness
- Main: decision queue with `delivery.accept/reject/revise`, `SendBackPicker`, notification delivery row (`decisions.tsx:146-165`), graph readers for manifest/verification.
- Now: `delivery.tsx` inline accept/reject on the `deliver` approval, manifest table, built tarball download, "how to run" extraction; queue card for the same approval.
- Build: reject → send-back (3.3); notification row = find `[decision:<id>]` in the workspace Sent folder (decision-notify.ts marker) and show sent/failed; after approval show the resolved time (`approvalById`).
- Acceptance: approve delivery inline → "Delivered · time"; reject with "send back to 8" → cursor at 8, build agent mailed.

### 3.9 Decision queue hygiene
- Problem: approvals from released runs stay pending forever; approve and reject both 409 ("Workflow deployment allocation is no longer active"); the queue keeps showing them.
- Build: in `decisions-fold.ts` and `project-list.ts`, keep only approvals whose `runId` is a deployment with status `deployed`; in `decisions.tsx`, on an ApiError containing "no longer active" show the banner once and drop the card. (A lane was mid-way on this; re-do from scratch, small.)
- Acceptance: restart the host with a pending `run_shell` approval outstanding → the queue is empty after reload.

### 3.10 Cosmetics from main
- "Where does this stand?" guidance card (`components.tsx:335-360` on main; source `api.guidance`) → derive from artifacts + readiness (3.2): current stage, what is missing, next action.
- `.turn-withdrawn` "Stopped before it was answered." for a person turn with no reply after a stage change.
- `<Roll>` rolling digits for counts.
- Stage 5 `versionDigest` shows no size (sizeBytes is hard-coded 0 in `toArtifactNode`; compute from content length when fetched or drop everywhere).

### 3.11 Concurrency and lifecycle (keep green)
- Already fixed: 401 boot routing (#434), session token persistence (#435), asset 409 (#445), git token race (#436), push visibility (#440), double deploy (#433), stale address (#437), opening mail dupes/loss (#428, #432, #439), per-project state (#431), notify sender auth (#441, #442). Any change to `ensureStageAgent`, the opening effect, or `pickDeployment` must be walked with two browsers on one project.

---

## 4. Open bugs and runtime facts
- CL-8634 stage 4 preview blank in headless capture (unverified in a real browser).
- Approvals for released runs cannot be resolved (hub 409) — hide them (3.9).
- Decision-notify to self lands as `[decision:…]` mail in the person's inbox; fine, but the bell may show it.
- Reply latency on local Ollama: qwen2.5:14b 10-50 s per stage (does not write real code); gpt-oss:20b 40-60 s, calls tools reliably, tends to pause with questions unless the brief pre-answers environment details. The hub's dispatch backstop fires at 5 minutes with no park/terminate; an approval park counts as parked.
- Two browsers on one project are safe now; the Decision queue is workspace-wide and cards carry the project title.
- A CRM run (project "Build a polished internal CRM…", stage 8 agent run_165a3067…) is parked mid-build on the running host (port 4880, data dir `scratchpad/ab4-data`); its workspace has only a scaffold. Restart from a fresh project after 3.5 lands.
- Follow-ups already filed in Linear under CL-8072: CL-8621, CL-8634, CL-8643…CL-8678 (all merged except the hygiene lane). Upstream asks (do not file in INTR without the operator): CL-8606 (`action` primitives inside onTrigger bodies), CL-8608 (anchor seq collision).
