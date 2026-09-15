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

2. ~~**`build.accept_evidence` requires a verifier report**~~ (plan §7) — DONE,
   PR #211. `engine.ts` now refuses to terminalize without a real verifier
   report. No confidence threshold: §7's second precondition is the human
   decision, which `guard.ts` already enforces by restricting the command to
   `project_owner`/`technical_approver`. A low-confidence report a human
   accepts is legitimate; accepting with nothing to accept against is not.

3. ~~**Panel reviews at stage 8**~~ (plan §8) — DONE, host-side, because the
   build runs beside the workflow rather than inside it. See CL-7991: that
   constraint is why 2,830 lines of stage-8 support live in the hub.

4. ~~**`targets` stops being inert**~~ (CL-7981) — DONE, PR #212 for the
   prompt side and the shared classifier. The verification side was already
   live from CL-8005. Both now read the same `classifyTarget`.

5. ~~**Move the stage machinery into packages**~~ (plan §7/§9) — **withdrawn,
   the premise was wrong.** §7 asks that the hub "enforce, not define", and it
   already does. The definition — `LEDGER`'s transition table, `COMMANDS`,
   `STAGES`, every state and authority — is 607 lines that already live in
   `packages/solutions-builder/src/ledger.ts`, and `engine.ts:16` and
   `guard.ts:24` import it. `engine.ts` declares no transition of its own
   (two mentions, both the imported symbol).

   What is left in `engine.ts` (874) is transaction handling, in-flight
   deduplication and command application; `engine-ledger.ts` (493) writes each
   committed command onto Interchange's conversation primitives through
   `hub-gaps`. Both are host mechanics. Moving them into packages would be
   moving mechanism out of the host, which is the opposite of the goal.

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

## Flagged upstream (we may not fix these)

- **CL-8011 — credential `use` grants don't survive the ancestor walk.**
  Resolution walks the tenant chain; authorization does not. The auto-grant
  `credentials.ts:265` writes is stamped with the tenant the credential was
  created in, and every production lookup is the single-tenant
  `collectGrants`. `collectGrantsInChain` exists, is implemented in both
  stores, is described in its own docstring as the credential-use path, and
  has **zero call sites** — grep of the whole vendored tree returns only the
  declaration, the two implementations and two test stubs.

  Not a live failure: nothing in `apps/hub` acts inside a project subtenant
  yet — every call goes through `tenantPath()`, the root workspace tenant. It
  becomes a hard blocker the moment a run launches in a project subtenant,
  which is exactly the tenancy model we want. Fix it upstream before moving
  runs into subtenants, not after.

## In flight

- design revision prompt (§10) into packages.
- the verifier rubric into packages.

## Deck, step 2 — and why it is not a deletion

#216 was additive on purpose: the hub path still works. Removing it is **not**
a straight deletion, and pretending otherwise would lose behaviour.
`render_deck` renders text-only slides. The hub's `deck.ts` also draws
illustrations and applies an uploaded template, and both need things the
sidecar tool does not have: a connected image provider, and a reader model to
choose subjects. So step 2 is two questions, not one task:

1. Can an image provider be reached from inside the closure? If yes, the
   illustration path can move and the hub path can go.
2. If not, the honest split is what #216 already drew — text slides in the
   workflow, illustrated decks host-side — and that should be written down as
   a decision rather than left looking unfinished.

Nobody should delete `apps/hub/src/deck.ts` until one of those is answered.

## Where the floor is

Worth being straight about: after the prompt text is out, `apps/hub` is close
to its floor under the current constraints. The bulk of what remains is
plumbing that only shrinks if something outside this repo changes —
`corbits-exec.ts` (797) goes when the bridge is retired and needs corbits-code
as a package; `hub-gaps.ts` (489) shrinks one function at a time as upstream
routes land; `migrate.ts` (671), `hub-client.ts` (771) and `hub-mount.ts` (490)
are the seam to Interchange itself.

So the honest reading of the scoreboard: the ratio improves a lot more from
here by **packages growing** — workflows, tools and skills that run in the
sidecar — than by the hub shrinking further. The deck tool is the model for
that: it left the hub, and its destination is the workflow closure, not
another host module.

## The pattern that is working

Four moves now, same shape each time: **the hub keeps the mechanism, the
package takes the words.** Prompt text, rubrics and the data types they render
are domain content; process spawning, database writes, clamps and gates are
host mechanics. Every move so far has been byte-identical on the strings, so
none of them can regress a run's behaviour — which is why they can go fast.

Survey of what is left (long string literals per hub file, `*.test.ts`
excluded): `hub-migrations.ts` 56 (SQL, stays), `stage-runs.ts` 10,
`deck-images.ts` 10, `completion-judge.ts` 10 (in flight), `source-material.ts`
9, `print-page.ts` 8, `corbits-exec.ts` 8. After the rubric lands, the
remaining prompt text in the hub is thin — the next reductions have to come
from item 5 (stage machinery) and item 6 (retiring the bridge), which are
structural rather than textual.
