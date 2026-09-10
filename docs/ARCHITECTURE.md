# Architecture

A native desktop shell over a persistent local host. The host is the product;
the window and the tray are clients. The host embeds the Interchange control
plane and runs the nine-stage lifecycle through Interchange's own workflow
runtime, in one process, on an embedded database.

## Components

```
apps/hub/src/                    the host: loopback API, guard, engine, persistence, the embedded Interchange hub
apps/web/                    the client
apps/desktop/                the native shell and tray
packages/solutions-builder/src/  the app package: the transition ledger, the workflows generated from it,
                             the specialist kit, the document format
```

**The app package** (`packages/solutions-builder`) is the product itself,
stated once: the ledger with every state, command, authority and transition
and the three forbidden cases; the Interchange workflow definitions generated
from it; the specialist kit and its prompts; and the document format the
client and the hub both parse. It depends on nothing in the apps and on no
platform internals. It is what will become the package installed into an
Interchange tenant. The hub boots vanilla (migrate, mount, serve) and the
client installs the package into the tenant on first launch and after every
credential change; what the hub still holds beside Interchange's tables is
the part of the tree that shrinks as it becomes vanilla.

**The hub** (`apps/hub`) owns the loopback API, the database, the guard that
enforces the ledger, the engine that applies commands, the providers and the
agent runs. The Interchange hub is Interchange's own hub app, mounted in this
process (`hub-mount.ts`). Platform writes go through that hub's HTTP API
(`hub-client.ts`) — the same calls a hosted hub would serve. Only embedding
files (`hub-mount`, `hub-keys`, `hub-migrate`, `hub-migrations.generated`,
`db`, `schema`, `migrate`) plus `hub-executor` and `hub-gaps` import
Interchange internals. It is the only place a run's state is written and the
only area allowed to reach a provider.

**What is not stored.** The decision waiting on a person is derived from the
run parked at its gate plus the ledger: title, consequence, required authority
and the exact versions it would freeze all follow from the run's state and
stage. The open question in a stage is read from the thread: the specialist's
turn that opened the round carries its questions as mail, and the human turns
after it are the answers. Neither has a table, so neither can drift from the
record it would restate. The desktop notification is a ping off the parked
run, never the record.

**The client** (`apps/web`) renders and asks. It imports the app package for
names and the document format, and never the hub.

**The desktop shell** (`apps/desktop`) starts the hub, opens the window on the
URL it prints, keeps a tray presence, and leaves the hub running when the
window closes.


## What still lives beside Interchange

Everything the product records is meant to be one of two things: the outcome
of a workflow step, or a version of an artifact. Where neither primitive can
carry a field yet, a row stays in the `builder` schema with the reason. The
list shrinks with every release; nothing is added to it without an upstream
issue first.

| Table | Why it is not native yet |
| --- | --- |
| `artifact_node`, `artifact_edge` | `@corbits/artifacts` versions have no metadata or parent-version fields. Stage, lineage, exact hash and provenance ride here until that PR lands upstream. |

A project is a child tenant of the workspace tenant; its policy and revision
live in the tenant config, and its participants are principals holding roles
there (`project-tenant.ts`). Commands, approvals, audience decisions and their audit trail are turns in a
per-project ledger agent session (`engine-ledger.ts`). The product's run record
(origin, source, cost approval, packet, checkpoint, why it ended) is folded
from the run mutations those turns carry (`runs.ts`); where the run stands in
the runtime is the hub's own workflow run on the project's deployment
(`hub-executor.ts`). Decision flags, worker questions and their answers are fields on the ledger
turn of the command that raised them; a build attempt's events are turns of
their own on the same thread. The frozen build packet and the delivery
manifest are artifact versions, produced by the run that froze or delivered
them; acceptance is the `delivery.accept` turn. Every direct table write that remains is named in
`hub-gaps.ts` as an upstream gap.
