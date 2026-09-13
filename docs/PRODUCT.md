# Product

Solutions Builder turns a half-formed problem into shipped software. Someone
arrives with a problem they can describe but have not scoped. They leave with
working software and the documents they needed to get approval along the way.

It is a desktop application. Work happens in nine stages. Each stage is drafted
by a specialist agent and released by a human decision. No agent holds approval
authority.

## Who it is for

- **Project owner.** Turns an unscoped problem into an accepted solution through
  guided stages and understandable decisions.
- **Budget approver.** Judges concept value early, then the exact plan cost.
- **Security or operations reviewer.** Inspects data boundaries, credentials,
  deployment and evidence.
- **Builder operator.** Supervises the build, its questions and its cost.
- **End-user representative.** Reviews the design, uses the delivered software,
  and accepts or rejects it.

One owner working alone is the ordinary case. Every role can be held by one
person, and the product collapses the ceremony when it is.

## The nine stages

Each stage consumes the approved record so far, produces a versioned document,
and waits for a human. Approving names the exact version that was read.

| | Stage | Produces | Human decision |
|---|---|---|---|
| 1 | Problem discovery | Problem brief | Enough has been captured |
| 2 | Solution shape | Constraints document | The bounds are accepted |
| 3 | Solution proposal | One chosen approach, rejected alternatives kept | One version is selected |
| 4 | GUI design | Mockups, interaction notes, acceptance criteria | Design accepted, after anchored feedback rounds |
| 5 | Concept approval | One package per audience | Each audience proceeds; then the owner approves |
| 6 | Build plan | Product requirements, then a plan with independent reviews | Plan accepted |
| 7 | Cost approval | Firm cost | Cost approved, then the plan is frozen |
| 8 | Build and test | Working software and evidence | Evidence accepted |
| 9 | Deliver | Delivery manifest | Delivery accepted |

Stage 7 cannot be approved the way the others are. Spend needs its own decision,
so it routes through a cost approval and a freeze. Stage 5 cannot be approved
until the configured quorum of audiences has recorded a proceed with no reject
or revise outstanding.

Stage 6 opens by gathering what stages 1 to 4 agreed into one product
requirements document, with an id on every requirement and acceptance
criterion. The plan is written against it and cites those ids, the panel
reviews the plan, and approving the stage names both documents.

Rejecting a stage routes back to a named earlier stage. The history is kept.

## How a stage feels

A specialist asks one question at a time. The document is written while the
conversation happens, so the reader watches it take shape rather than waiting
for a wall of text. The status is the workflow's own step in plain words:
"Drafting", "Revising the draft", "Waiting for your approval".

When the person reading holds the approving authority, the gate is one action:
"Approve and continue", or "Approve the cost" at stage 7. When someone else
holds it, the same button reads "Send for approval". Nobody configures a mode.

A product guide stays in the corner of every screen. It says where the project
stands, what is missing, and what to do next. It can read and speak. It cannot
write a document or take a decision.

## Connecting a model

Before the first draft, the person connects an inference provider in Settings:
an API key, a sign-in with ChatGPT or xAI, or a local endpoint that speaks the
OpenAI protocol. The key is checked against the provider before it is kept.
Everything that does not need a model works without one.

If a provider refuses, the next one in the person's preferred order is tried,
and the message names every provider that was asked. There is no silent
fallback from a local endpoint to a cloud one. Unavailable is a state the
product shows.

## Promises

These are product requirements, not style.

- **A control that does not exist is absent, never simulated.** Where the
  product cannot observe something, it says so rather than drawing it.
- **An unknown is not a pass.** A process exiting cleanly is not evidence that
  the work is right.
- **Secrets never appear.** Not in a document, a log, a prompt or a response.
  The interface sees a status and a boolean.
- **Approvals name exact versions.** If the bytes changed after someone read
  them, the approval is refused and the person is shown the newer version.
- **No agent approves anything.** Every specialist is bound to a role that
  holds no approval authority. This is enforced, not requested in a prompt.
- **Closing the window does not stop the work.** Already-authorised work runs
  to its next human gate, the wait is recorded, and a desktop notification
  fires when it gets there.

## What is not finished

- **Stage 8 is a bounded build.** It runs one supervised command and shows its
  final output and exit status. Which coding agent runs it is chosen in
  Settings — Corbits Code by default, Claude Code or Codex otherwise — and
  the choice changes the tool, not what the interface can see. While it
  runs, the interface shows the worker's output as it is written and, for a
  worker with a lifecycle hook (Corbits Code), the worker's own report of
  each turn and the tools it called. There is no timeout: a build takes as
  long as it takes, and cancelling it is the control. When the worker ends,
  its exit status is shown but is not a verdict: the person reads what it
  left and accepts it, marks the attempt failed, or tries again. Only a
  worker that could not run at all fails an attempt by itself. There is no agent
  roster, no steering and no checkpoint resume. The interface reports each
  of those as unavailable rather than faking them.
- **Delivery evidence is not verified byte for byte.** The manifest exists; the
  hash checks against an install target do not.
- **Branches are in the record but not the interface.** Only the main branch
  is used today.
- **Cost drift, materiality routing, retention receipts and project deletion**
  have no surface yet.
- **Signing, notarisation and Windows** are not done.
- **A test suite** beyond the smoke checks does not exist.
