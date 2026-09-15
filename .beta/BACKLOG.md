# internal-beta: toward Interchange-native

Goal: `apps/hub` is a thin host. The meat — workflows, agents, tools, skills —
lives in `packages/*`. Today: hub 21,132 lines / packages 3,570. Six to one the
wrong way round.

Rules for every iteration:
- never touch `vendor/interchange/`
- commit to `internal-beta`, never push, never merge to main
- `bun run check` exits 0 before the commit, run alone
- the end-to-end bench still works: seed to stage 8, build, inspect the artifact
- prefer deleting host code over adding it; a change that grows `apps/hub` needs a reason

## Ordered work

1. ~~**Verifier judges the deliverable by using it** (CL-8005)~~ — DONE.
   `completion-judge.ts`. Exercises the deliverable through its declared
   `targets`, returns a confidence level clamped by mechanical evidence so the
   model can lower it but never raise it. Verified end to end: a Sonnet build
   was driven through the `cli` target and rated `medium`, withholding `high`
   because a correction was never exercised.

2. **`build.accept_evidence` requires a verifier report** (plan §7) — in
   flight. `engine.ts:710` checks descriptors only; §7 wants "complete
   verifier report and human stage-8 approval". The report now exists, so this
   is finally fixable.

3. ~~**Panel reviews at stage 8**~~ (plan §8) — DONE, host-side, because the
   build runs beside the workflow rather than inside it. See CL-7991: that
   constraint is why 2,830 lines of stage-8 support live in the hub.

4. **`targets` stops being inert** (CL-7981).
   `domain.ts:112` types it; `build-attempt.ts:227` pastes it into a prompt and
   nothing branches on it. It should select seeding and verification modality.

5. **Move the stage machinery into packages** (plan §7/§9).
   `engine.ts` + `engine-ledger.ts` = 1,343 lines. §7: one contract generated
   from the ledger, consumed by workflow definitions, guards and tests. The
   hub should enforce, not define.

6. **Retire the bridge** (CL-7991) — blocked on corbits-code as a package.
   `corbits-exec.ts` is 770 lines of subprocess supervisor reimplementing
   continuation, progress and verdicts the substrate already has.

7. **Close numbered gaps** (`hub-gaps.ts`): 1, 4, 5, 6, 7, 8, 9 remain (2 and 3
   landed). Each one deletes a direct write. #9 is `createHubServer` — upstream
   `apps/hub` is not vendored, so the mount is ours.

8. **Ledger as projection** — the dual-write is why `hub-executor.ts` needs
   `divergent`, `alignRunWithLedger`, `forgetExecution`, `awaitingSignalFor`.
   Overturns plan §7's "ledger is the only state machine"; needs an explicit
   ruling before anyone starts.
