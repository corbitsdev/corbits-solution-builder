# Architecture

A native desktop shell over a persistent local host. The host is the product;
the window and the tray are clients. The host embeds the Interchange control
plane and runs the nine-stage lifecycle through Interchange's own workflow
runtime, in one process, on an embedded database.

## Components

```
src/contracts/     the transition ledger and the typed boundaries
src/host/          API, persistence, guard, engine, lifecycle, the embedded hub
src/orchestration/ providers, the agent kit, the bounded build bridge
src/ui/            the client
src-tauri/         the native shell and tray
```

**Contracts** hold the ledger: every state, command, authority and transition,
plus the three forbidden cases. Contracts import nothing else in the tree.

**Host** owns the loopback API, the database, the guard that enforces the
ledger, the engine that applies commands, and the mounted hub. It is the only
place a run's state is written.

**Orchestration** is the only area allowed to reach a provider or an agent
runtime. It holds the specialist definitions, the inference failover loop, the
OAuth clients and the stage-8 bridge.

**UI** renders and asks. It never imports persistence, a schema or the engine.

**Desktop shell** starts the host, opens the window on the URL the host prints,
keeps a tray presence, and leaves the host running when the window closes.

## Three rules, enforced

`bun run check` fails when any of these is broken.

- **One state machine.** The ledger is the single machine-readable contract.
  The guard is its only enforcement point. The engine is the only writer of a
  run's state. Interchange workflow definitions are generated from the ledger,
  so the state machine and the deployed workflows cannot drift.
- **One direction.** Contracts depend on nothing. Only orchestration touches a
  provider. The client never writes persistence.
- **Exact versions.** An approval names a version and the content hash the
  approver saw. If the bytes moved, the approval is refused as stale.

## Storage

One embedded Postgres database, two schemas. `public` is Interchange's, applied
verbatim from the vendored migrations. `builder` is ours, for what Interchange
does not model: projects, participants, branches, the document graph and its
lineage, approval records, decision flags, human waits, build packets and
events, delivery manifests, audit events, the outbox, command receipts, host
preferences, stage questions, the specialist kit, agent run records, the
compatibility matrix and change notices. Three foreign keys point from
`builder` into `public`: project to tenant, participant to principal, local
provider to tenant.

## A stage, end to end

1. **A specialist drafts.** Its system prompt is a commit in the hub's git
   registry on the definition's deploy ref. Inference runs through the
   platform's `runInference`, so retries, timeouts, SSE parsing and error
   classification are upstream's. If a provider refuses, the next one in the
   operator's order is tried.
2. **The conversation** is an Interchange `agent_session`. Each turn is a
   signed `session_mail` row with an `inference_turn` and `turn_part` beside
   it. As it grows, a platform `Compactor` folds older turns into a standing
   brief. Partial text streams to the client from process memory and is never
   recorded until the draft completes.
3. **A document appears**, versioned and content-hashed, with every version it
   came from kept rather than replaced.
4. **The human gates it.** The project's lifecycle run executes through the
   platform's `runtimeRun`, in process. The run parks at a real `awaitSignal`
   gate. That gate is where "where is this project" lives; there is no second
   copy. Approving delivers a signal naming the exact version and hash.
   Rejecting routes back to a named earlier stage.

Run execution state is process memory. A restart loses in-flight runs, and the
engine relaunches a project's lifecycle on demand when it finds none, because
launching is idempotent.

## Authority

Who may take a decision is Interchange's. The ledger's authorities are `role`
rows, held through `principal_role`, and evaluated by `@intx/authz`. Every
seeded agent definition is bound through `agent_role` to a `specialist` role
that approves nothing. "No agent gets human approval authority" is a fact in
the hub, not a line in a prompt.

Whether a command may move a run from one state to another is ours. That is
the ledger, and the platform has no concept of it.

## The build bridge

Stage 8 runs one supervised `corbits exec` call in a workspace under the data
directory. The bridge reports exactly what it can observe: prompt submission,
final text, exit status. It declares live events, session inspection, questions
and approvals, steering and checkpoints as unavailable, and the client renders
from that list. It never synthesises events from stdout and never passes a
flag that skips the operator's own permission configuration.

## Lifetime

Closing the window does not stop the host. Authorised work continues to its
next gate. The wait is committed to `human_wait` before any notification is
attempted, so a failed notification is a missed ping and never a lost decision.
An outbox carries side effects out of the transaction that decided them.

## Relationship to Interchange

Interchange is vendored and mounted in process. The intent is to run on the
platform rather than beside it, and to carry as little parallel machinery as
possible.

**Reused from the platform**

- Schema, migrations and stores for tenants, principals, roles, grants,
  credentials, providers, models, offerings, workflow definitions, sessions,
  mail and inference turns.
- The workflow runtime. Stage runs execute through `runtimeRun` with the
  in-memory adapters, and park at `awaitSignal`.
- Inference mechanics: `runInference`, the shipped adapters, the retry policy,
  SSE accumulation and error classification.
- The curated model catalog for capabilities and quirks of known models.
- Authorisation through `@intx/authz`.
- The git registry for definition bodies, through the platform's repo store.
- Conversation compaction as a platform `Compactor`.

**Deliberately ours**

- **The ledger.** Stage transitions, forbidden cases and the cost gate have no
  platform equivalent.
- **Ordered failover across providers.** The platform runs one source per
  call and says so. The loop that tries the next provider and names every one
  that refused is external composition, which is what upstream recommends.
- **The live key probe.** Nothing upstream asks a provider what a given key
  actually serves. The catalog is a static curated list; we probe, then take
  capabilities from the catalog for models it knows.
- **Failure messages with remediation.** The platform classifies errors; we
  turn a reset time into "in about an hour" and attach the action that fixes
  it.
- **The document graph, approvals by hash, human waits with titles and
  consequences, audit events, the outbox.** The platform's `approval` approves
  a tool call. Ours approves named document versions. Different subjects.
- **The keychain.** The platform expects encryption keys in the environment. A
  desktop app mints them once and keeps them in the OS keychain; the
  environment still wins when set, so the same hub can run hosted.

**Still duplicated, and should collapse**

- **Local providers.** An OpenAI-compatible endpoint connected in Settings is
  written to both `builder.local_provider` and the platform's `provider`,
  `model_provider` and `model_offering` rows. One should go, and the platform's
  is the one with model, offering and pricing under it. Ours carries the
  operator's preference order and validation timestamp, which would need a
  home.
- **Guessed capabilities.** A model the catalog does not know is recorded with
  `plain-text` only. Invented data in the platform's own tables is worse than
  a gap; the probe should supply what it learned.
- **The supervisor.** The platform's full executor is a subprocess with signed
  IPC and a mail bus. We drive the runtime body directly and keep execution
  state in process memory. Moving to the supervisor is what makes runs survive
  a restart without relaunching.
