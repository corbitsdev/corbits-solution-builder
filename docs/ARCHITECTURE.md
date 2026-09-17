# Architecture

A native desktop shell over a persistent local host. The host is the product;
the window and the tray are clients. The host embeds the Interchange control
plane over an embedded database. Each project's nine-stage lifecycle runs as
a deployment placed on an Interchange workflow sidecar — a child process the
host spawns per allocation, not a routine inside the host's own process
(`workflow-deploy.ts`, `hub-mount.ts`). `lifecycle-run.ts` is the in-process
client of that deployment: it fires the run, delivers gate commands to it as
signals, and derives where the run stands by folding the run's own committed
events — it does not execute the workflow itself.

## Components

```
apps/hub/src/                    the host: loopback API, guard, command dispatch, persistence, the embedded Interchange hub
apps/web/                        the client
apps/desktop/                    the native shell and tray
packages/solutions-builder/src/  the app package: the transition ledger, the lifecycle workflow generated from it,
                                 the specialist kit, the document format
packages/installer/src/          installs the app package into a tenant, driven by a hub transport the host supplies
packages/keychain/src/           OS keychain mint/read for the hub's two at-rest encryption keys
vendor/interchange/              the Interchange control plane, vendored under LGPL-2.1
```

**The app package** (`packages/solutions-builder`) is the product itself,
stated once: the ledger with every state, command, authority and transition
and the three forbidden cases; the Interchange lifecycle workflow generated
from it; the specialist kit and its prompts; and the document format the
client and the hub both parse. It depends on nothing in the apps and on no
platform internals.

**The installer package** (`packages/installer`) does the installing: ensures
the signed-in principal's workspace tenant, its roles and grants, the seeded
workflow definition, the curated kit's skill assets, and the per-project
lifecycle deployment; opening a project — its own tenant, authority and
credential delegation — is its `createProject`. It takes a hub `Transport`
(`@intx/hub-client`) already authenticated as that principal, plus the two
facts about sidecar placement only the host process knows; it
never reaches a database, a keychain or an Interchange internal itself, and
depends on nothing in `apps/`. The hub boots vanilla (migrate, mount, serve)
and does the host-only repairs (legacy-tenant adoption, credential
migration). First launch signs up or in against `/hub/api/auth`; the client
then runs this package over the host's `/hub` mount as that session on first
launch and after every credential change (`apps/web/src/client.ts`); smokes
still call the same package through `scripts/host-install.ts`. What the hub
still holds beside Interchange's tables is the part of the tree that shrinks
as it becomes vanilla.

**The hub** (`apps/hub`) owns the loopback API, the database, the guard that
enforces the ledger, the command dispatch that applies host-side effects, the providers and the
agent runs. The Interchange hub is Interchange's own hub app, mounted in this
process (`hub-mount.ts`). Platform writes go through that hub's HTTP API
(`hub-client.ts`) — the same calls a hosted hub would serve. Only two files
import an Interchange internal directly — `hub-mount.ts` (`@intx/crypto`,
`@intx/db`, `@intx/hub-api`, `@intx/hub-sessions`) and `hub-keys.ts`
(`@intx/crypto`). `scripts/check-boundaries.ts`
also allow-lists four more files as the embedding layer — `db`, `schema`,
`migrate` and `hub-migrate` — though none of them currently has an `@intx`
import at all; they reach Interchange's data model through raw SQL and a
shared drizzle schema instead. `hub-migrations.ts` reaches the same layer by
text-importing the vendored `.sql` files directly (relative paths, not
package specifiers), so it needs no such exemption. Seven further files use
only the platform's runtime surface (`@intx/inference`,
`@intx/inference-catalog`, `@intx/agent`, `@intx/types`, `@intx/workflow`),
which the same script treats as product code rather than platform code,
because using the platform's own inference and workflow runtimes is the point
of building on it: `agent-conversation`, `catalog`, `failure`,
`lifecycle-run`, `inference`, `responses` and `workflow-seed`.
Everything else in the hub reaches Interchange only through `hub-client.ts`.
The hub is also the only app allowed to reach a provider. Run state moves in
the workflow definition in the app package, not in `command-dispatch.ts`. All three rules are enforced
by `check:boundaries`, not left to habit — this paragraph is drawn from its
`PLATFORM_PACKAGES`/`RUNTIME_PACKAGES` lists and `PLATFORM_FILE` allowlist,
cross-checked against every literal `@intx` import under `apps/hub/src`.

**The client** (`apps/web`) renders and asks: it signs up or in against the
mounted hub, then reads and commands over the host's loopback API
(`client.ts`), folds where the project's run stands from the same `/hub`
events the run committed (`run-fold.ts`), runs `install()`, `createProject()`,
and project housekeeping that is the hub tenant (rename, archive, delete,
stakeholders) through `@solutions-builder/installer` over `/hub` as that
session, and never writes persistence itself. `GET /projects/:id` is the
ledger, artifacts, and the tenant/anchor that fold addresses — not a second
copy of the machine. It imports the app package for names, the document
format and that fold, the installer package for those calls, and never
the Interchange hub's own modules directly.

**The desktop shell** (`apps/desktop`) starts the hub, opens the window on the
URL it prints, keeps a tray presence, and leaves the hub running when the
window closes. When `SOLUTIONS_BUILDER_HUB_URL` is set, the shell opens that
origin instead and does not spawn a local hub process.

**What is not stored.** The decision waiting on a person is derived from the
run parked at its gate plus the ledger: title, consequence, required authority
and the exact versions it would freeze all follow from the run's state and
stage. A `human_wait` table used to copy this out at each gate; it is gone
(`decisions.ts`). The open question in a stage is read from the thread: the
specialist's turn that opened the round carries its questions as mail, and the
human turns after it are the answers (`questions.ts`). Neither has a table, so
neither can drift from the record it would restate. The desktop notification
is a ping off the parked run, never the record (`notify.ts`).

## What still lives beside Interchange

Everything the product records is meant to be one of two things: the outcome
of a workflow step, or a version of an artifact. Where neither primitive can
carry a field yet, a row stays in the `builder` schema with the reason. The
list is meant to shrink with every release, and nothing is added to it
without an upstream issue first. `local_provider` and `human_wait` are two
rows the list already lost: a local model endpoint is now a catalog entry
Interchange itself owns (`registerProviderCatalog` in `catalog.ts`), and the
parked-decision copy is gone, as described above (`schema.ts`,
`decisions.ts`).

| Table | Why it is not native yet |
| --- | --- |
| `artifact_node`, `artifact_edge` | `@corbits/artifacts` versions have no metadata or parent-version fields. Stage, lineage, exact hash and provenance ride here until that PR lands upstream. |

A project is a child tenant of the workspace tenant; its policy and revision
live in the tenant config, and its participants are principals holding roles
there (`project-tenant.ts`). Commands, approvals, audience decisions and
their audit trail are turns in a per-project ledger agent session
(`command-ledger.ts`). The product's run record (origin, source, cost
approval, packet, checkpoint, why it ended) is folded from the run mutations
those turns carry (`runs.ts`); where the run stands in the runtime is folded
from the hub's own workflow events on the project's deployment — by the host
when it delivers a signal (`lifecycle-run.ts`), and by the client when it
draws the stage (`apps/web/src/run-fold.ts`). The project GET does not fold.
Decision flags, worker questions and their answers are fields on the ledger
turn of the command that raised them; a build attempt's events are turns of
their own on the same thread. The frozen build packet and the delivery
manifest are artifact versions, produced by the run that froze or delivered
them; acceptance is the `delivery.accept` turn. Every write the host makes
goes through a hub route now (CL-8075 closed the last of them: registering a
definition, sessions and conversation turns, listing child tenants, reading
a deployment's provisioner binding, and writing/reading a workflow asset's
source tree, all landed in `vendor/interchange/packages/hub-api` — see
`vendor/interchange/PATCHES.md`). `createHubServer` is the one gap left open
on purpose: the vendored tree ships `@intx/hub-api`'s `createApp`/`createAuth`
and `@intx/hub-sessions`'s factories, not a single entry point that accepts an
injected pglite handle and keychain keys the way this desktop host needs, so
`hub-mount.ts` still composes those factories itself instead of calling one.
