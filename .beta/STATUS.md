# Status — updated as work lands

## Scoreboard
| when | apps/hub/src | packages/* |
| --- | --- | --- |
| start of night | 21,132 | 3,570 |
| after stage-8 judge + panel | 21,841 | 3,578 |
| deck merged out (#208) | 21,166 | 4,207 |
| accept_evidence gate (#211) | **21,365** | **4,093** |

Correction: an earlier row here claimed the deck move was -1,881. That
compared two branches with different bases and was wrong. Measured across the
merge itself it is **-675**. Still the largest single reduction so far.

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

Goal: that ratio inverts. Hub vanilla, meat in workflows/agents/tools/skills.

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
