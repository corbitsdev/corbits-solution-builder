# BUILD_PLAN: native specialist workflow packages

Reshape PR #660 (`refactor/specialist-kit-split`) so each `packages/specialist-*` **is** an Interchange workflow package. Kit is catalog only. Stop string-building `workflow.js`.

Hub `DeployWorkflow` still requires a tenant-owned `workflow` asset (`source.kind === "asset"`). Stay on `format: "source"`. Tarball/registry later. Do not edit vendor.

## Target (one specialist)

Example: `packages/specialist-brainstormer/`

```
package.json          name @solutions-builder/specialist-brainstormer
                      interchange.workflow: "./workflow.js"
                      deps: @intx/workflow, @intx/agent, @solutions-builder/specialist-shared
src/prompt.ts         system string; imports SHARED_RULES / INTERVIEW from shared
src/role.ts           catalog metadata only: id, title, mission, stages, produces, promptKey, …
src/workflow.ts       defineAgent + defineWorkflow + mail trigger
                      import { systemPrompt } from "./prompt.ts"
                      import SOURCE from "./inference-source.js"  // external, written at deploy
workflow.js           Bun.build output (like scripts/project-workflow-pack.ts)
```

`specialist-shared` stays a **library** (rules, `role()` metadata helper). It is not a workflow.

Tools: declared **in that package**. Production `artifactTools` stays false — brainstormer/constraints/… workflow.ts has `tools: []` (or only what that stage already ships: delivery on verifier). Do not put artifact bindings in the static entry until a later per-package tools-on PR. Grant overlay (`registerWorkflowArtifactsBearer`) stays installer-side when tools are on later.

## What dies

- `specialistEntrySource` template that `JSON.stringify`s the prompt into a generated `defineWorkflow` string (`packages/solutions-builder/src/specialist-source.ts`).
- Fake member at `packages/specialist/workflow.js` synthesized in `renderSpecialistSource`.
- Baking `SOURCE` into the entry. Write `inference-source.js` beside the compiled entry at deploy (same idea as `namer-source.js`).

## What stays

- `kit.ts`: `AGENT_KIT`, `agentFor`, `panelPrincipals`, `agentById`, seed types. Imports `role` metadata from each package, not prompts-as-the-kit.
- Per-project asset `sb-project-<id>-stage-N` (this hub route requires tenant-owned asset).
- `pushWorkflowSourceTree` + `workflows.deploy({ kind: "asset", format: "source", commitSha, packageName, entry: "./workflow.js" })`.
- Closure members from `workflow-closure.ts`.
- `artifactTools` default false in apps/web.

## Deploy (`specialist-deploy.ts` / `renderSpecialistSource`)

`renderSpecialistSource` copies, it does not generate the agent:

1. Compiled `workflow.js` from the specialist package (static, same bytes for every project).
2. Package `package.json` with `interchange.workflow`.
3. Overlay `inference-source.js` (model pin).
4. Existing closure members the entry actually imports.
5. Root workspace `package.json` as today if still required for source-ref.

`specialistEntryIsCurrent` compares the **static** `workflow.js` (+ overlay policy: ignore inference-source.js, or compare prompt/entry only). Honest: first deploy after this lands **will** redeploy every live specialist once, because the entry is no longer the old template.

## Pack

Add `scripts/specialist-pack.ts` (or extend project-workflow-pack): `Bun.build` each `src/workflow.ts` → `workflow.js`, external `@intx/workflow`, `@intx/agent`, `./inference-source.js`. Wire into `ui:build` / whatever already packs the project workflow so the installer can fetch static bytes (browser cannot Bun.build). Mirror: `apps/web/public/specialists/<id>/workflow.js` same pattern as `apps/web/public/project-workflow/`.

## Phases on this branch (one PR)

Do all of this on `refactor/specialist-kit-split`. One commit after the existing move, or amend if never pushed as “done” — **do not force-amend the already-pushed move**; add a second commit.

1. Shared: keep specialist-shared; add nothing workflow-shaped there.
2. Each of the 17 role packages: `prompt.ts` (move system string), `role.ts` (metadata), `workflow.ts` (real defineWorkflow).
3. Pack script + public static output.
4. Point `renderSpecialistSource` at those files; delete the template path.
5. Kit imports `role` from each package.
6. Tests: kit.test / stack.test still pass; new test that brainstormer `workflow.js` contains `defineWorkflow` and does **not** contain a string-copied novel prompt via `specialistEntrySource`; installer test that rendered tree’s entry equals the packed file.

## Out of scope

Registry deploy, vendor patches, `format: "tarball"`, flipping tools on in apps/web, #389, scrape-path PRs, occupying a second set of package names.

## Proof the operator can smell

- `packages/specialist-brainstormer/src/workflow.ts` exists and imports `@intx/workflow`.
- `git grep specialistEntrySource` is gone or only test leftovers.
- Opening a project still deploys `kind: "asset"` `format: "source"` with `entry: "./workflow.js"`.
- Prompt text for Brainstormer still matches what #660 moved (no recut).
