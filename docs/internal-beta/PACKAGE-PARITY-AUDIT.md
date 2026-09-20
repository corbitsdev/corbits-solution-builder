# Package parity audit — Wave 1

Audit date: 2026-09-19.  Scope: reusable specialists, tools, contracts, and
native source-deployment closure.  This is an audit; it makes no package or
deployment changes.

## Result

The current stage specialist is a native, single-step mail workflow, but it
is *generated inside the Solutions Builder app package* and deployed with one
shared closure.  It is therefore not independently reusable or packable as a
specialist package yet.

The smallest useful first boundary is one generic native workflow package plus
one focused, independently deployable problem specialist.  That proof is now
implemented in the three packages below and validated from tarballs in an
isolated consumer. Do not split all nine prompts yet; the tracker contract
remains open.

## Current facts

| Area | Evidence | Consequence |
| --- | --- | --- |
| Specialist definition | `packages/solutions-builder/src/specialist-source.ts` emits source text and embeds `agentFor(stage).system`. | No package owns an `interchange.workflow` entry or exports a configurable native definition. |
| Prompt scope | The generated definition has one `defineAgent` / one mail-triggered unbounded step.  Stage 1 additionally injects the evaluator rubric; stage 6 injects requirements and four panel prompts. | The one-step topology is appropriate; prompt aggregation is not a reusable specialist API and would recreate a large-kit injection if copied forward. |
| Tool dependencies | Only stage 5 imports deck; stage 8 imports posix and publish-workspace; stage 9 imports delivery/deliver. | Stages 1–4, 6, and 7 need no sidecar tool package. |
| Deployment closure | `renderSpecialistSource` always adds all vendored members, `@solutions-builder/app`, `tools-deck`, and `tools-delivery`; its member package always declares all of `WORKFLOW_PACKAGE_DEPENDENCIES`. | Every stage pays for unrelated packages and the umbrella app, even when its rendered entry imports neither. |
| Existing tool packages | `tools-deck` and `tools-delivery` import `@solutions-builder/app/deck` and `/delivery` respectively. | They are reusable only after those pure domain modules move to a contract/helper package; tools must not depend on the umbrella app. |
| Publication readiness | All local packages are `private: true` and use `workspace:*`; no package has a `files` allowlist, build/publish artifact, or clean-consumer test. | Existing tarball tests prove only a synthetic tarball and Interchange's resolver, not installability outside this monorepo. |
| Current static manifest | `apps/web/public/closure/manifest.json` contains `@solutions-builder/app@0.1.0` twice with the same filename and distinct hashes. `scripts/closure-pack.ts` first adds the intended app tarball, then discovers the workspace-linked app again as an external dependency. | The manifest can advertise a hash different from the file later written at that filename. Resolve this before treating the closure as a package-release source. |

## Boundary recommendation

Start with these package responsibilities; all names are candidates pending
coordinator approval.

```
@corbits/specialist-contracts
  pure, versioned input/output and evidence references; no UI, hub client,
  persistence, tracker state, or provider imports

@corbits/specialist-workflow
  createMailSpecialistWorkflow(config): native single-step mail definition;
  config supplies id, prompt, inference source and explicit tools

@solutions-builder/specialist-problem
  focused Problem prompt, default `interchange.workflow` entry, and a
  configurable builder based on specialist-workflow; no nine-stage kit

@solutions-builder/tools-deck and @solutions-builder/tools-delivery
  explicit optional capabilities, depending only on small pure deck/delivery
  helpers rather than @solutions-builder/app

@solutions-builder/app
  composition: stage-to-specialist mapping, project IDs, approved context,
  house policy, tracker integration, and UI-facing product helpers
```

`@corbits/specialist-contracts` should start deliberately small:

```ts
type ArtifactRef = { artifactId: string; version: number; contentHash: string };
type SpecialistInput = { projectId: string; stageKey: string; approved: readonly ArtifactRef[]; message: string };
type SpecialistOutput = { specialistId: string; artifact: ArtifactRef; summary: string };
```

These are content/provenance references, never approvals or transition
commands.  Tracker decisions need their own coordinator-owned contract after
the native tracker proof establishes its signal/action topology.

The generic builder must take its prompt as a required string.  It must not
take `AGENT_KIT`, stage numbers, audience policy, or a full project object.
The first `specialist-problem` package owns only the stage-1 interview prompt
and its focused rubric.  A stage-6 package, if later justified, owns its
requirements/panel prompt itself rather than accepting the whole kit.

## Clean-consumer acceptance test

Add a package-specific test that, from an empty temporary consumer directory:

1. packs `specialist-contracts`, `specialist-workflow`, and
   `specialist-problem` as real tarballs;
2. installs only those tarballs plus their pinned runtime dependencies;
3. imports the documented builder and package default entry, verifies the
   `interchange.workflow` metadata and exported definition; and
4. feeds those tarballs to Interchange's existing closure resolver, then
   deploys the problem specialist through the embedded hub/process
   provisioner without `apps/web` or `@solutions-builder/app` present.

The existing `tarball-pack.test.ts` successfully validates the platform's
asset tarball reader, and `workflow-closure.test.ts` validates extraction of a
synthetic shared closure.  Neither performs this clean installation nor an
isolated specialist deployment.

## Native source deployment findings

Use the platform's asset/source deployment and dependency-closure resolver;
do not add a package resolver.  The installer already performs the correct
asset push, pin, visibility check, and deployment steps in
`packages/installer/src/specialist-deploy.ts` and
`packages/installer/src/workflow-deploy.ts`.

After package interfaces are approved, make the closure stage-specific from
the generated entry's declared package roots:

- stages 1–4, 6, 7: `@intx/workflow`, `@intx/agent`, and the selected
  specialist package only;
- stage 5: add `@solutions-builder/tools-deck` and its pure deck helper;
- stage 8: add `@intx/tools-posix` and the delivery publish capability;
- stage 9: add `@solutions-builder/tools-delivery` and its pure delivery
  helper.

The asset must continue to pin exact resolved versions and integrity through
Interchange.  `workspace:*` is acceptable only inside the generated source
asset when every member is shipped alongside it; it is not clean-consumer or
publication-ready metadata.

## Implemented proof files

- `packages/specialist-contracts/package.json` and `src/index.ts`: v1
  content/provenance references, explicitly non-authoritative.
- `packages/specialist-workflow/package.json` and `src/index.ts`: configurable
  native one-step mail workflow builder. Its only declared runtime dependencies
  are exact `@intx/agent@0.3.0` and `@intx/workflow@0.3.0`.
- `packages/specialist-problem/package.json`, `src/index.ts`,
  `src/problem-prompt.ts`, and `src/workflow.ts`: a focused problem-discovery
  specialist, exported configurable builder, and `interchange.workflow` entry.
- `scripts/specialist-package-proof.ts`: packs the three packages, installs
  them in an empty consumer along with the local pinned Interchange tarball
  closure, and imports/validates both default and configured native definitions.

All three manifests contain no `workspace:*` dependency. The consumer uses a
local pinned Interchange closure because the vendored platform packages do not
yet constitute a registry publication contract. This is intentionally not
evidence that these packages are ready to publish.

## Future composition files

- `packages/solutions-builder/src/specialist-source.ts` (replace source-text
  generation with composition/imported specialist metadata after approval)
- `packages/installer/src/specialist-deploy.ts` (select declared per-stage
  roots rather than unconditionally adding every member)
- `packages/installer/src/workflow-closure.ts` (generalize member extraction
  by selected package roots)
- `scripts/closure-pack.ts` and `scripts/pack-closure-static.ts` (derive,
  deduplicate, and verify the package closure)
- `scripts/check-boundaries.ts` (teach the checker the narrowly permitted
  specialist package authoring surface)

The coordinator owns root `package.json`, `bun.lock`, and shared closure
integration.  Do not alter those until package names and the tracker-facing
contracts are agreed.

## Blockers and risks

1. The native tracker proof has not selected the authoritative decision
   payload or handoff protocol.  Exposing a tracker contract now would freeze
   an unproven topology.
2. Interchange packages are vendored workspace members at `0.3.0`.  A clean
   consumer cannot resolve `workspace:*`; each independently deployable
   package needs either a platform-provided/pinned runtime closure or real
   published/pinned Interchange dependencies.  Decide the supported consumer
   installation mode before changing `private`.
3. The closure manifest duplicate described above must be fixed and covered
   by a unique `(name, version, filename)` assertion before a tarball is used
   as release evidence.
4. Moving deck/delivery helpers is a real dependency change because their
   packages currently import the app.  Keep it separate from the first
   problem-specialist proof.

## Verification performed

`bun test packages/installer/src/tarball-pack.test.ts packages/installer/src/workflow-closure.test.ts packages/tools-delivery/src/sidecar-bundle.test.ts`
passed: 14 tests, 0 failures.

`bun --conditions intx-src scripts/check-boundaries.ts` passed: boundaries
hold across 143 files.

`bun --conditions intx-src scripts/specialist-package-proof.ts` passed. It
created retained isolated smoke data, packed and installed the three local
tarballs plus the pinned platform closure, and printed `clean consumer imported
and validated native problem specialist`. It also exercises configurable
inference, tools, and static context. The script detects and uses real emitted
Interchange declarations generated from the pinned vendor source for a
clean-consumer compile. Missing declarations fail the proof rather than being
skipped or replaced with a custom declaration shim.

The clean-consumer TypeScript compile passes. Repository-wide `bun run
typecheck` is currently failing after the unrelated removal of the legacy
Interchange ambient shim; those app/embed/tool incompatibilities are outside
this package lane. The integrated `bun run check` was not run for this
package-only lane.
