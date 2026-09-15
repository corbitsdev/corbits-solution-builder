# Status — updated as work lands

## Scoreboard
| when | apps/hub/src | packages/* |
| --- | --- | --- |
| start of night | 21,132 | 3,570 |
| after stage-8 judge + panel | 21,841 | 3,578 |
| deck authoring out (#208) | 21,166 | 4,207 |
| accept_evidence gate (#211) | 21,365 | 4,093 |
| prompt text out (#212, #213) | 20,038 | 4,257 |
| design prompt + rubric out (#214, #215) | 19,848 | 4,513 |
| deck tool in the closure (#216) | 19,912 | 4,747 |
| art direction out + bench in (#232, #234) | 19,874 | 4,887 |
| main merged + outline deduped (#235) | 19,907 | 4,949 |
| the build-run findings (#236-#240) | **19,962** | **4,970** |

Two honesty notes on this table. From the `#212` row down the hub count
excludes `*.test.ts`, which the rows above it did not separate — the trend is
real either way, but the rows are not all measured the same. And I rebuilt
this table once: several edits to it silently no-op'd when their anchor text
had moved, leaving rows missing and stale bolding. The numbers above are the
ones actually measured at each merge.

Correction: an earlier row here claimed the deck move was -1,881. That
compared two branches with different bases and was wrong. Measured across the
merge itself it is **-675**.

The middle row is the lesson: stage-8 work has nowhere to go but the hub while
the build runs beside the workflow instead of inside it (CL-7991). The deck
move is what progress looks like when the code has somewhere else to live.

## Merged into internal-beta
- #208 deck authoring out of the hub (CL-8006) — intermediate; destination is
  a tool in the workflow closure running in the sidecar
- #209 stage consequence copy into packages (CL-8007)
- #211 `build.accept_evidence` requires a verifier report (plan §7) — the
  command validated descriptor shape and terminalized, so a build nobody
  verified could be accepted. It now refuses without a real report. No
  confidence threshold: §7's second precondition is the human decision, and
  `guard.ts` already restricts the command to `project_owner`/
  `technical_approver`. A low-confidence report a human accepts is their call;
  accepting with nothing to accept against is not. +65 hub lines, the only
  growth tonight, and it buys the gate §4 says the bridge can never be.

- #214 design revision prompt (§10) into packages. All 20 prompt strings
  byte-identical — checked, not assumed: §10 documents the revision prompt as
  deterministic ("the same feedback produces byte-identical bytes, so a
  regenerated design is attributable"), so a whitespace change would have been
  a real regression.
- #215 the verifier rubric into packages. `judgeSystemPrompt` and
  `coverageSummary` diffed **identical** against the hub original; the only
  changes in the moved code are a type name (`ExecutionCheck` →
  a structural `JudgeExecutionCheck`, so the hub-only type need not move) and
  a constant alias (`LEVELS` → `CONFIDENCE_LEVELS`, the same array). The clamp
  — `minLevel(parsed.level, ceiling)`, the model may lower confidence and never
  raise it — stays in the hub, where enforcement belongs.

  A note on my own method: my first check compared whole string literals with
  a regex and reported "0 of 23 verbatim", which was wrong — the regex was the
  wrong tool, not evidence of rewording. Diffing the moved function bodies is
  what actually answered it.

- #216 **the deck renders inside the workflow closure.** New
  `packages/tools-deck` exposing `render_deck` via a `sidecar-bundle` entry
  (the convention `@intx/tools-posix` uses), declared in
  `WORKFLOW_PACKAGE_DEPENDENCIES`, shipped as a closure member, and given to
  stage 5's specialist. It calls the deck authoring already in
  `@solutions-builder/app/deck` — nothing re-parses markdown or redraws a
  slide.

  **The gate earned its keep here.** `check:ledger` passed, and the agent had
  even hand-built a closure tree and watched `render_deck` produce a real 82KB
  PowerPoint — and it was still broken. The package imported `defineTool` from
  `@intx/agent` without declaring it, so the specifier could not resolve from
  inside the package's own directory once materialized. Only the probe sidecar
  in `smoke:sidecar` caught it. Resolution happens where the import is
  written, not where the workflow entry is. One line of `package.json` fixed
  it; nothing else would have found it.

- #217 `check:ledger` asserts stage 5 carries the `render_deck` factory,
  reading the name from the package so a rename cannot silently pass.
- #218 the product says **why** a project cannot run. The reason was computed
  and stored in a map whose docstring read "for the status line", and never
  reached the status line. Now: "Can't run yet — no model provider is
  connected" / "…no host is free for this project's sidecar", with the words
  in `packages/next-step.ts` and the hub supplying only the fact.
- #219 **the gate runs the behaviour smokes it was skipping.** Six suites
  existed, passed, and ran in `check:full` only — which nothing runs. 200
  checks, 66 seconds, previously optional.

- #226 the three orphans behind `check:ui`'s failure, and the gate now runs
  the interface audits. `check:ui` was outside the gate *because it was red*.
  Three distinct causes, not one: `.dictated-row-start`/`-center` were live
  and the checker could not see through `` `dictated-row-${align}` `` (fixed
  by teaching it that an interpolation is a prefix wildcard — a prefix
  matching no rule still fails); `material-add` was an unreachable `??`
  fallback with no rule, since all four call sites pass a className;
  `composer-material` was a class with no rule.

  `smoke:responsive` deliberately stays out of the default gate. It drives
  headless Chrome and gets OOM-killed under load — one of two isolated runs
  died with SIGKILL at 70-90 load average, and it killed a full `check` run
  too. A gate that fails for reasons unrelated to the change teaches people
  to ignore red. It stays reachable from `check:full`, so `check-shards`
  counts it as gated rather than abandoned.

- #232 deck art direction into packages. The art director's system prompt, its
  content builders, plan parsing and `illustrationPrompt` are text; the
  provider calls, credential resolution, model ranking and disk cache stay.
  `parsePlan` returns `null` in the package instead of throwing a hub error
  type, and the hub re-throws the identical `HostError` at the boundary —
  checked, because a move that quietly turns a throw into a null is how an
  error gets swallowed.
- #234 **the bench harness enters the repo.** The script that drives a fresh
  workspace through the lifecycle against a real provider was untracked, so
  "the end-to-end bench still works" — a rule in this very backlog — lived on
  one machine. Two real bugs found by running it: `--stage 7` did the whole
  walk and then died demanding `--out`, which only stage 8 needs; and the host
  cleanup swallowed its own failure with `.catch(() => undefined)`.


- #236 Brian's slide-build refusal reason, restored after my `--ours` merge
  dropped it.
- #237 **the local endpoint stores the URL that actually answered.** Connect
  Ollama by its plain URL and it validated, reported ready, listed its models,
  then 404'd every inference call — a provider that is connected and cannot
  answer a single request. `validateLocalEndpoint` normalised `/v1` for its own
  probe and threw it away. Three runs, same model: bare → 404; `/v1` by hand →
  parked at stage 2; bare with the fix → parked at stage 2.
- #238 **the bench runs the real specialist rounds.** Stages 1-7 used to write
  canned text with `producer: "human"` — no specialist, no prompt, no model. It
  proved the ledger advances and nothing else, which is how #237 survived a
  whole night of green checks. Real is now the default, with
  `--seed-artifacts` kept for jumping to a stage with dummy data, and every
  artifact asserted `producer === "agent"`.

Goal: that ratio inverts. Hub vanilla, meat in workflows/agents/tools/skills.

## Process note, from a mistake

I edited a worktree while its agent was still running in it. The agent saw an
unexplained commit appear, correctly treated it as foreign, and reset the
branch — discarding my work and reporting that "something else in this shared
environment is auto-committing to worktrees". It was right to do that, and the
diagnosis was only wrong because the intruder was me.

**A worktree belongs to its agent until the agent reports.** Verify after, not
during. Nothing was lost, but it cost a full gate cycle.

## Two gate lessons, one night

Both found by accident, both the same shape — a check that cannot fail:

1. Landing #218 I noticed `bun run check` never called `smoke:guidance`. The
   proof I had asked for could not have failed the gate. Fixed in #219.
2. #216's deck tool passed `check:ledger` and a hand-built closure and was
   still broken; only the real probe sidecar caught it.

Neither was a missing test. In both cases the test existed and passed — it
just was not on the path that decides whether something merges. That is the
same shape as the three unwired contracts (CL-8011, CL-8012,
`grantRequirementsFor`): the piece is checked, the path is not.

`check-shards.ts` deserves credit: it rejected the first attempt at #219 and
was right both times — two smokes I thought were outside the gate were already
in `check:core`, and the CI matrix needed the new shard or it would have run
locally and never in CI.

## Caught up with main

Ten of Brian's commits merged in. Three needed *refactoring* in rather than
merging, because main still keeps the deck authoring in `apps/hub` and this
branch moved it to `packages` in #208:

- `apps/hub/src/deck.ts` — taken as deleted, but verified rather than assumed:
  all 98 lines main contributes to the conflicted block are already present
  verbatim in `packages/solutions-builder/src/deck.ts`, including the
  `Deck | null` refusal from "a package without a slide outline is refused".
  Nothing of his is lost.
- `scripts/deck-smoke.ts` — main imports `packageOutlineProblem` from
  `deck.ts`, which used to re-export it. Each symbol now comes from where it
  is actually defined.
- `apps/hub/src/package-outline.ts` — his new module imported `DECK_DENSITY`
  from `./deck-settings.js`, where it no longer is.
- `apps/web/src/app.tsx` — auto-merge took main's `KIND_WORDS`, which predates
  the `build_review` kind this branch added with the stage-8 panel. It would
  have failed typecheck, not silently: the record is exhaustive over
  `ArtifactKind`.

`rerere` recorded both conflict resolutions, so the next time main touches
`deck.ts` the same resolution replays instead of being re-derived.

Gate green after the merge, and **Deck smoke went 32 → 36** — his new outline
checks now run here.

## The merge left a duplicate

Worth naming because it is the failure mode this whole branch is about. His
`package-outline.ts` and our `packages/deck.ts` now both define `DeckSlide`,
`outlineSlidesIn` and `decisionLinesIn`, and they have **already drifted**:
the hub matches the section via `OUTLINE_HEADING.toLowerCase()`, the package
via the literal `"deck outline"`. Identical today. Change the constant and the
check that refuses a package and the renderer that draws its slides would
disagree about what a slide outline is.

Resolved in #235: one definition, in `packages/solutions-builder/src/deck.ts`,
with `outlineSlidesIn` now matching the section via `OUTLINE_HEADING` so the
constant is load-bearing for both readers rather than decorative for one.
`apps/hub/src/package-outline.ts` deleted outright rather than left as a
re-export shim — a file that only forwards is a hop, not a home. Deck smoke
stayed 36/36, which is the check that proves it: it covers the renderer and
the refusal both.

## Merging on top of Brian: the rule, and how I broke it

We merge **on top of** main. His logic comes in; our direction — the client
drives the experience, the hub is thin — does not get reverted to take it.
Those are not in tension: his change is usually *behaviour*, ours is *where
the code lives*, and the merge keeps both.

I broke that once. Resolving the main merge I ran:

    git checkout --ours apps/hub/src/deck.ts

which takes **our whole file**, not just the conflicted hunk. Brian had also
changed that file outside the conflict, and it went with it.

What was lost: his slide-build refusal asks the parser *which* problem the
package has — no `### Deck outline` section at all, versus a section whose
items are not numbered slides. Mine flattened both into one static sentence,
so a person whose outline used bullets was told the section was missing when
it was not. Restored in `026ebf0`, against the packages copy of the parser,
architecture intact.

**How I checked, rather than guessing:** for each of his ten commits, every
added line of real length, tested for presence anywhere in our HEAD. Of ~330
added lines, 9 came back missing — 8 were import paths made moot by moving
that parser into packages, 1 was superseded by his own later commit, and the
one above was a real loss. That sweep is cheap and worth repeating after any
merge where `--ours` or `--theirs` was used on a file both sides touched.

**The rule:** never `checkout --ours/--theirs` a whole file when both sides
changed it. Resolve the hunk. If the file must be taken wholesale because it
moved, diff the other side's commits against the new home afterward.

## A mistake, and what it cost

I pushed a merge commit whose message described two fixes its tree did not
contain. During a conflicted merge `git commit` writes the index: I had
resolved the two conflicted files with `git add`, but the other two I only
edited in the working tree. **The gate I ran was green against the working
tree, so it proved nothing about what I committed** — and I reported it as
green.

`origin/internal-beta` did not typecheck for about half an hour. It was found
by a subagent reporting an "unrelated, pre-existing" typecheck error and being
exactly right; it reported it rather than quietly fixing it, which is the only
reason I looked. Repaired in `a7d6905`.

The lesson is narrow and worth keeping: **after resolving a merge, `git add -A`
or check `git status` before committing, and run the gate on the committed
tree, not the working tree.**

## The first real stage-8 build, and what it showed

1032s, four continuations, `stopReason: stalled`, **`confidence: none`** — and
the deliverable *works*: the hub's own checks ran its suite in that workspace,
**26 pass, 0 fail**, typecheck clean. A real ICP CLI with template parsing,
weighted matching, a reason per criterion and a review gate.

It scored zero for two reasons, neither the model's fault:

- **CL-8015 — the worker can write but cannot run.** `--permission-mode
  acceptEdits` permits edits, not Bash. It wrote a working deliverable and
  spent four continuations hand-tracing code it was never allowed to execute,
  saying so honestly every turn. `--allowedTools` permits named tools without
  the blanket bypass the bridge rightly refuses.
- **The verifier could not find how to run it.** `discoverEntryPoint` checks
  `start`, `main` and six root filenames; the deliverable declared
  `"icp": "bun run apps/icp-cli/src/main.ts"`. So the one implemented modality
  was never exercised, the ceiling was mechanical, and the judge was never
  consulted. In flight: state the contract in `targetGuidance`, and recognise
  `bin` — without guessing at arbitrary script names, which is how a verifier
  starts lying.

Both share a root worth naming: **the deliverable was never actually run, by
anyone, at any point in the pipeline.** The worker couldn't, and the verifier
couldn't find it. The one thing that did run it was the mechanical `bun test`
check, which is why we know it works at all.

## In flight
- CL-7981 `targets` stops being inert: `classifyTarget` moves out of the hub
  into `packages/solutions-builder/src/targets.ts`, and the worker prompt
  stops pasting `Targets: ["cli"]` as raw JSON and starts saying what each
  declared target will actually be exercised with.
- qwen end-to-end under the judge, re-run after the manifest-crash fix.

## The judge works end to end
A Sonnet build was driven through the `cli` target: the interview ran, an ICP
was proposed, leads came back with reasons. The judge read that transcript
against the requirements and returned **medium, not high** — because a
correction was never exercised, which is a real requirement the run never
tested. `stopReason: stalled`, not complete. Verified by running the
deliverable myself.

A qwen build the same night died on an unguarded `JSON.parse` of a
package.json the worker had broken with a stray comma. That is fixed: a
malformed manifest is now a failing check carrying the parse error, which
blocks completion and reaches the next turn. Five defects tonight were found
by running the product; none by the gate.

## Closed without merging
- #210 (CL-8009) keyed the lifecycle asset on audience count. It dedupes and
  is worse: unrelated projects share an asset by an incidental property, it
  added 74 lines to the hub, and it makes the deploy serialization more
  necessary. Its investigation was the valuable part and CL-8009 is rewritten
  around it: **project tenants are created with `parentId` and never used** —
  every call routes through the workspace tenant, so the hierarchy is built
  and never walked.

## Landed: completion is judged, not computed (CL-8005)
`completion-judge.ts`. The rule that produced five false "complete" verdicts
is gone. What replaced it:

- **A mechanical ceiling the model cannot raise.** `minLevel(parsed.level,
  ceiling)` — the model's answer is clamped by what was actually exercised.
  `"high"` is unreachable without evidence the thing ran with real input and
  produced output, whatever the model says.
- **`targets` selects the modality.** Only `cli` is implemented: it starts the
  entry point and feeds it real input drawn from the requirements' own example
  section, never fabricated. Other targets report "not exercised" — no false
  pass, no dead end.
- **Confidence, not a boolean** — none/low/medium/high, with reasoning.
- **The judge is only asked when there is something to interpret** (ceiling at
  medium or above); below that the facts decide alone.
- **An unreachable judge holds at the ceiling, never raises**, and a `high`
  ceiling is downgraded to medium when the verdict cannot be read.
- The worker's own tests survive only as labelled self-reported corroboration.

18 regression tests cover all five false-complete routes plus a trivial
"prints done" entry point. Verified the clamp myself at `completion-judge.ts:493`.

## Landed on internal-beta
- baseline commit lands (seeded workspace is diffable)
- continuation loop: builds run until the work is done, not until the worker
  goes quiet; failures feed into the next turn
- verification runs the deliverable instead of checking files exist
- attempt verdict rests on what was produced
- seeded toolchain the worker can actually run
- workers that can write (claude-code, codex were both no-ops)
- `bun test` is in the gate — it never was, and a failing test was hiding
- vacuous checks, deleted checks and empty suites no longer read as done

## Open findings not yet worked
CL-7956 sandbox as a shared package · CL-7957 build runs on the app's provider ·
CL-7958 hard kill bricks a workspace · CL-7962 one-shot bridge · CL-7977
toolchain · CL-7980 staged builder · CL-7981 `targets` inert · CL-7987 no CLI
installed · CL-7991 build as a workflow · CL-8003 silent prompt truncation ·
CL-8004 gamed completion · CL-8005 agent judgement

## Notes for whoever picks this up
- Five false "complete" verdicts came from asking "did the checks pass?" — a
  question the worker controls. The plan asks whether a verifier can confirm
  the output does what was required, with a human approving at stage 8.
- `bun run check` was green for every real defect found tonight. The
  end-to-end drive caught them all. Trust the drive, not the gate.
- Every agent report tonight needed verifying; three were wrong.
