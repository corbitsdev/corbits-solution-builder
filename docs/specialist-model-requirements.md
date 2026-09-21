# Specialist model requirements — deploy-path verdict (CL-8783)

Specialists declare no model needs today, and the hub resolves their models
anyway. This note records where each half lives so a future slice can join
them without re-deriving the path.

## Verdict

A stage specialist deploys as a workflow through the allocation path, not as
a model-pinned instance:

- The installer hands the hub the FULL ordered offering chain as
  `sourceOfferingIds` (`packages/installer/src/specialist-deploy.ts`,
  deploy site). The hub re-resolves that chain itself at provision time and
  at recovery time (`resolveSourcesByOfferingIds` in
  `vendor/interchange/packages/hub-sessions/src/workflow-allocation-service.ts`,
  provision ~line 511 and recovery ~line 769), so a rotated credential (secrets
  are re-resolved, never persisted) or a visibility / delegation re-check is
  picked up with no redeploy. A post-deploy priority reorder or newly added
  offering is NOT picked up: the hub iterates the stored id array in deploy-time
  order, so reordering needs a redeploy.
- `resolveModelSources` is NOT on this path. Only the instance-launch route
  reaches it (`vendor/interchange/packages/hub-api/src/run-source-resolution.ts`,
  ~line 60). A specialist never launches as an instance.
- The workflow definition carries no `modelRequirements` manifest:
  `ensureWorkflowDefinitionForAsset`
  (`vendor/interchange/packages/hub-sessions/src/workflow-definition-ensure.ts`)
  projects the definition row over the asset with no model manifest, so the
  deploy lands as a workflow rather than an instance launch.
- The deploy schema carries no model needs either: `DeployWorkflow` in
  `vendor/interchange/packages/hub-api/src/routes/workflows.ts` (~line 84)
  has `source`, `entry`, `sourceOfferingIds`, `defaultSourceOfferingId` and
  `pin` — no `modelRequirements` field. `sourceOfferingIds` is the whole
  inference story for a specialist deploy.
- `offerings[0]` in `specialist-deploy.ts` (pick site) selects only the
  installer's local render pin — the `(provider plugin, canonical model)`
  pair written to `SOURCE_PIN_PATH` (`packages/specialist/source.json`) for
  `stageSpecialistSourcePin` to report. The hub never reads that file when
  deploying; it is a reporting artifact, not the deploy path.
- Credential-push already excludes deployment-anchor runs:
  `pushSourceUpdatesToTenants` in
  `vendor/interchange/packages/hub-sessions/src/credential-push.ts` queries
  `anchorRunId IS NULL`, so per-instance `sources.update` pushes never reach
  a specialist's anchor run. A specialist's only credential story stays the
  per-deployment bearer `ensureWorkflowArtifactsCredential` mints (CL-8719).
  This slice changes nothing there.

## Where modelRequirements would land (deferred full slice)

The platform already has the need type: `ModelRequirement` /
`ModelRequirements` in `vendor/interchange/packages/types/src/catalog.ts`
(canonical model, optional capability and provider-preference guards). A
future slice that lets specialists declare model needs would have to:

1. Add `modelRequirements` to the `DeployWorkflow` schema
   (`routes/workflows.ts`) and thread it into the launch spec the allocation
   service persists.
2. Resolve it hub-side (the `resolveSourcesByOfferingIds` family, plus the
   `sources.update` push that already skips anchor runs — decide whether
   declared needs change that exclusion).
3. Replace the `SOURCE_PIN_PATH` reporting pin with the declared needs, and
   only then remove the pin file.

## This slice changes nothing at runtime

Comment and doc annotations only: `specialist-deploy.ts` carries the verdict
at the pin constant, the pin read, the render write, the offering pick, the
deploy call and the credential call. No hub, vendor, schema or resolve change;
`SOURCE_PIN_PATH` stays. A future builder consumes this note and the deferred
list above.
