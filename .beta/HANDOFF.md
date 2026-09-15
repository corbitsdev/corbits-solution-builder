# Handoff — internal-beta

Written at the end of a long session, for whoever picks this up (including me).

## Where the branch is

23 PRs merged into `internal-beta`. `bun run check` green. Up to date with
`main` — Brian's ten commits are merged and refactored into our structure, not
reverted.

`apps/hub` 21,132 -> ~19,990 · `packages/*` 3,570 -> ~5,000

## The one thing that matters most

**The nine-stage workflow now works end to end, unstubbed, verified by using it.**

    seconds: 362 | stopReason: complete | continuations: 0
    confidence: high | source: judge
    target cli: exercised=True ranOK=True realInput=True

Real specialists wrote every artifact through a real provider, a real coding
agent built the deliverable, the verifier exercised it with input taken from the
requirements, and the judge returned high with sound reasoning. I ran the CLI
myself with my own input and it works.

The first real build of the night, for contrast: 1032s, four continuations,
stalled, confidence none.

## What was actually wrong (all found by running the product; the gate found none)

1. **The bench had never called a model.** Stages 1-7 wrote canned text with
   `producer: "human"`. Walks were being reported as end-to-end evidence. This
   is the error that hid everything below it.
2. **A local endpoint connected, said ready, listed its models, and 404'd every
   inference call.** The probe normalised the API version segment for its own
   check and stored the URL that did not work.
3. **The worker could write but not execute.** It wrote a working deliverable
   and hand-traced its own code for four continuations because every command
   returned "requires approval".
4. **The verifier could not find how to start a working CLI**, so the only
   implemented modality was never exercised and confidence was capped at none.
5. **The client froze a placement where a modality belongs**, making every build
   started from the product unverifiable.
6. **The worked example was present and invisible** — a subheading ended the
   section the example lived in, so the CLI was run against EOF.

## Open, in priority order

**CL-8012 (upstream, urgent).** A tool call from a step nested in a loop body is
always refused. Blocks every workflow tool, including the build stage's own, and
gates the whole "logic lives in workflow tools" direction. A live proof branch
exists (`cl-8012-live-proof`) whose two failing assertions are the acceptance
criteria — deliberately not merged, because they fail honestly today.

**CL-8011, CL-8013 (upstream).** Credential grants do not survive the tenant
ancestor walk; every stage iteration leaves a run marked running.

**The seed promises a platform it does not provide.** The build workspace globs
`vendor/interchange/packages/*` and `vendor/workbench/packages/*`, and the
agent instructions point at platform packages — but `vendor/` does not exist in
the workspace. Verified: the worker *can* create directories and reach the
network (mkdir ok, registry 200), and `@intx/workflow` and `@intx/agent` are
published (200), while `@corbits/core` and `corbits-code` are not (404). So the
fix is to either ship the vendor tree into the workspace or tell the worker to
install the published packages. This is ours, and it is the blocker for "it
builds with Interchange and Corbits packages".

**Ticket hygiene.** Five issues were filed the wrong way (hand-written, essay
bodies, local file paths). CL-8011 and CL-8012 have been condensed to the
`/gaas:linear-create` shape with reproduction documents attached. **CL-8013,
CL-8014 and CL-8015 still need the same treatment** — repro docs are written at
`/tmp/repro/CL-801{3,4,5}-repro.md` but not yet uploaded.

## Things worth not relearning

- The end-to-end build is the test. A green gate has never found a defect here.
- Never `git checkout --ours <file>` when both sides changed it — it takes the
  whole file, not the hunk. That silently dropped one of Brian's improvements.
- After resolving a merge, check `git status` before committing and run the gate
  on the committed tree. A gate run against the working tree proves nothing
  about what was pushed.
- A worktree belongs to its agent until the agent reports.
- Name the capability, not the vendor.
- "High confidence the deliverable meets the specification" means exactly that.
  The build that earned it produces leads from a hardcoded array, because the
  requirements never said where data comes from. Fixed forward in the stage-2
  prompt, but the lesson generalises.
