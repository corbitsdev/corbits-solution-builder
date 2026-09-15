# internal-beta: toward Interchange-native

Goal: `apps/hub` is a thin host. The meat — workflows, agents, tools, skills —
lives in `packages/*`. Today: hub 21,132 lines / packages 3,570. Six to one the
wrong way round.

Rules for every iteration:
- never edit a worktree while its agent is still running in it — the agent
  will rightly treat your commit as foreign and may reset it away
- never touch `vendor/interchange/`
- commit to `internal-beta`, never push, never merge to main
- `bun run check` exits 0 before the commit, run alone
- the end-to-end bench still works: seed to stage 8, build, inspect the artifact
- prefer deleting host code over adding it; a change that grows `apps/hub` needs a reason

## How this loop runs

**The end-to-end build is the test.** Run a real stage-8 build against a real
provider, read what came out, fix what it exposed, run it again. The refactor
items below are worth doing, but they are not the driver — a passing gate has
never once found a defect that running the product did not find first, and
tonight's tally is the same shape: every real bug came from running something.

Each turn: run the build, read the artifact and the transcript, fix the worst
thing it showed, repeat.

    bun --conditions intx-src scripts/bench-run.ts --stage 8 \
      --out <dir> --problem <file>
    # SOLUTIONS_BUILDER_SEED_BASE_URL -> the Ollama endpoint
    # BENCH_WORKER_ID / BENCH_WORKER   -> the coding agent that writes the code

What counts as a result: the verifier's confidence and its reasoning, whether
the deliverable actually runs, and what the worker did when it got stuck.

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

## Observed, not yet worth fixing

- **A worked example's halves can be bold labels rather than subheadings.**
  #244 separates input from output when the document names them as headings
  (`### Input`), and takes a flat example whole otherwise. A real run wrote
  `**Input**:` as a bold label inside a flat section, so both halves are fed.
  That is the honest fallback and it still supplies real input — but it means
  a deliverable can be handed its own expected output.

  Left alone deliberately: matching bold labels is heuristic creep on a parser
  whose strictness is the point, and the fix belongs upstream anyway — the
  requirements prompt could ask for the halves as subheadings, which is one
  instruction rather than one more pattern. Worth doing if a build is ever
  seen to echo its expected output and look correct.

## Ours, urgent, from running the product

- **CL-8014 — every build from the UI was unverifiable.** The client froze
  `targets: ["local"]`; `"local"` is a placement, not a modality, so
  `classifyTarget` placed it as `other`, nothing was exercised, and the
  completion judge could never be consulted. Fixed in #239: the client asks
  "How will this be used?" in plain language, marking which choices are
  verified today, and `build.freeze` refuses an unclassifiable target at the
  boundary. That refusal immediately caught two more call sites with the same
  bug.
- **CL-8015 — the worker can write but cannot run.** In flight.

## Flagged upstream (we may not fix these)

- **CL-8013 — every stage iteration leaves a run marked "running" with an
  active principal.** A *successful* nine-stage walk logs 13 ERROR lines from
  `hub-session-lookups.ts:435`, one per iteration. Upstream's own comment says
  what that branch costs: the run stays "running" with its principal active,
  there is no automatic re-fire, and the ERROR is "the only record that the
  row needs a manual flip".

  Two possibilities I could not distinguish without querying the workspace DB:
  the iteration runs have no row at all (leak is imaginary, the message is
  misleading), or they have one under a different anchor (leak is real). Either
  needs fixing. Only visible since #238 — the canned walk never created an
  iteration run, so no terminal event ever fired.

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

## BLOCKER — tools in a workflow do not work yet (CL-8012)

The most important thing found tonight, and it was found by trying to prove
#216 rather than trusting a passing probe.

A tool call from a step nested inside a `loop` body is **always refused**:

```
workflow-child authorize: credentialsSnapshot has no entry for stepId package-0
```

`capability-walk.ts` keys `perStep` by top-level `stepOrder` only and folds
loop-body steps into the loop's own entry, so a leaf step in a body never gets
a credentials-snapshot entry. Upstream, in `vendor/interchange/`.

This is not about the deck. It blocks **any** tool from **any** loop-nested
step, stage 8's `posix` tools included — which sit in exactly that shape. As
far as we can tell, an agent step inside our stage loop has never been able to
call a tool in a deployed workflow at all. That may be part of why the build
runs through the host-side bridge instead of inside the workflow (CL-7991);
if so, fixing this makes retiring the bridge much cheaper.

**Read this before writing another workflow tool.** More tools written against
this seam will all be blocked the same way. The live proof is on branch
`cl-8012-live-proof`, deliberately not merged: its two assertions fail today
and they are the acceptance criteria for the upstream fix, not a regression.

Separately real and ours: `grantRequirementsFor` (`seed-kit.ts:225`) has no
production caller — only `kit-smoke.ts` asserting its shape — and
`workflow-seed.ts:60` registers definitions without `grantRequirements`, a
field `hub-gaps.ts:95` already accepts. Not the cause of the above, but it
will matter the moment the upstream defect is fixed.

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

## The sweep result

I named the shape, so I swept for it rather than leaving it as an observation.
556 exported symbols across 105 files, every reference traced repo-wide
excluding `vendor/` and `node_modules/`, plus 30+ policy-shaped optional
fields. The method re-derived `grantRequirementsFor` independently, which is
the check that it works.

**Exactly one further instance**, and it is milder than the three known ones:
`executionUnavailable()` (`hub-executor.ts:567`) has zero callers anywhere, so
the reason a project cannot run — `no_offering` or `no_host`, already computed
and stored in a map whose docstring says "for the status line" — never reaches
the status line. The user sees a generic state instead of what is missing.
That is a dead end, which is the one thing this product is not allowed to be.
In flight.

A correction to the sweep's own wording: it said divergence has "no code path,
log, or API surface". There is a `console.error` at `hub-executor.ts:300`, so
divergence is not silently lost — `divergentProjects()` being uncalled is a
loose end, not a hole. Left alone deliberately.

Everything else cleared, and the cleared list is worth as much as the finding:
ledger-consistency helpers with live production twins, formatting duplicates,
and optional-parameter defaults are all legitimate. `buildDraftPrompt` remains
the model of a fine one — exported for testability, and the real path calls it.

## The shape to watch for

Three instances tonight of one failure mode: `collectGrantsInChain` (CL-8011),
the loop-body grants (CL-8012), and `grantRequirementsFor`. Each is a contract
written, an implementation written, a test asserting the implementation — and
the one line connecting it to anything missing. All three were invisible
because the tests check the piece rather than the path.

**An exported function whose only callers are its own tests is the signature.**
Worth a deliberate sweep.

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
