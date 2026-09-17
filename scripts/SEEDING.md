# Seeding a workspace to any stage and state

`bun run seed:workspace -- --stage <1-9> --state <name>` puts one project at
the named stage, in the named state, through the same command dispatch a person
or the host itself would use (`apps/hub/src/command-dispatch.ts`'s `execute`). Nothing is
written to a row directly, so nothing gets seeded into a state the product
could not actually reach.

Run `bun run seed:workspace -- --list` to print every combination this script
knows how to reach, and every one it refuses, with why.

## What is seeded alongside the stage

Reaching stage N means every stage before it was drafted, submitted and
approved for real: an immutable artifact version exists for each of them, an
`ApprovalRecord` exists for each approval, and stage 5's audience quorum is
recorded (both configured audiences deciding "proceed") unless the requested
state is specifically the partial-quorum one. Nothing is skipped or faked to
save a step.

## Determinism

Every artifact body, the project's policy, and its title are fixed text —
nothing timestamped or random goes into what is seeded. The product still
mints its own ids for the project, its runs and its artifacts
(`apps/hub/src/ids.ts`, `crypto.getRandomValues`), and this script does not
touch that, so two runs are not byte-identical. What is identical is the
stage, the state, the run history's shape, the artifact content, and the
policy — which is what "the same command twice gives the same workspace"
means here. Because the title is fixed per stage/state pair (`Seed: stage N
<state>`), a run first tombstones (`project.delete`) any project already
seeded under that title, so re-running does not pile up duplicates in the
workspace list.

## The build stage, and "parked mid-attempt"

Stage 8 is the one the issue calls out as hardest to reach by hand. All seven
`BUILD_STATES` are seedable, driven purely through `execute()` — no worker
process is ever spawned, because none of `build.start_attempt`,
`build.wait_for_human`, `build.interrupt`, `build.fail`, `build.cancel` or
`build.accept_evidence` require one to move the ledger; a real bridge process
is a separate concern from what state the run is in.

Two of the seven are "parked mid-attempt" — an attempt that started and then
stopped without either finishing or being thrown away:

- `--stage 8 --state waiting_human` — the run's own vocabulary for this
  (`apps/hub/src/runs.ts`'s `PARKED_BY` table) is literally "parked": the
  worker asked a question mid-attempt and the run is waiting on a person to
  answer it.
- `--stage 8 --state interrupted` — the attempt was interrupted with a
  checkpoint retained, so it is resumable rather than gone. This is the state
  `build.resume` exists to resume.

`evidence_accepted` also seeds cleanly, and — because accepting evidence is
itself the transition that opens stage 9 — carries a stage-9
`delivery_review` run alongside it, exactly as `build.accept_evidence` always
does.

## What cannot be seeded, and why

- **Stage 9 has no `in_progress`, `failed` or `cancelled`.** A stage-9 run is
  created directly at `delivery_review` by `build.accept_evidence`; it never
  passes through `in_progress`, so there is nothing for `stage.fail` or
  `stage.cancel` to act on. This is the ledger, not a gap in the script.
- **Stage 9 has no `backtracked` of its own.** `delivery.reject` and
  `delivery.revise` route to an *earlier* stage's run, which is what ends up
  `backtracked` — stage 9 itself never carries that state.
- **`--stage 8 --state backtracked` is refused, on purpose.**
  `build.route_material_change` does leave the source build run labelled
  `backtracked` in its history, but that is terminal history, not the
  project's current position — the project moves on to the new run at the
  earlier stage. `--stage 7 --state backtracked` seeds that same transition,
  reported from the run that is actually current afterward.
- **Real bridge output is not seeded.** `evidence_accepted`, `delivered` and
  `archived` write fixed bytes into the build run's real workspace directory
  (`apps/hub/src/corbits-exec.ts`'s `workspaceFor`) so `delivery.accept`'s
  hash check passes deterministically — but no worker ever actually ran, so
  there is no transcript, no turn log and no tool-call history on these runs.
  Exercising a live worker is what `bun run smoke` and `bun run walk` are for.
- **Only one representative route per state.** Several different commands
  can produce the same state (`stage.reject`, `stage.revise` and
  `stage.route_back` all leave a run `backtracked`, for instance). The script
  seeds one of them per state, not every command that could have produced it.
- **Ids are not deterministic.** See "Determinism" above — the content and
  shape are, the row ids are not, because minting those is the product's job
  and this script does not reach around it.

## Adding a new stage or state

If a stage gains a new artifact kind or a new reachable state, add it to
`ARTIFACTS_FOR_STAGE` or the driving logic in `scripts/seed-workspace.ts` and
add a line to `CATALOG` (or `UNSEEDABLE`, with the reason) so `--list` keeps
describing what the script can actually do.
