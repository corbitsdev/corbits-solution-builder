# Status — updated as work lands

## Scoreboard
| | lines |
| --- | --- |
| `apps/hub/src` | 21,132 |
| `packages/*/src` | 3,570 |

Goal: that ratio inverts. Hub vanilla, meat in workflows/agents/tools/skills.

## In flight
- **CL-8005 delivery-verifier** — judges by USING the deliverable. Confidence
  derived from what was exercised, `targets` picks the modality, reports
  honestly rather than refusing. Agent working in `internal-beta` directly.
- **Panel at stage 8** (plan §8) — four independent principals reviewing
  evidence, not just stage 6. Agent working in `internal-beta` directly.
- **CL-8006 deck behind the Documents seam** — 807 lines of PptxGenJS
  authoring out of the hub. Worktree `build/pr-8006`, PR into `internal-beta`.

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
