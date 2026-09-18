# Architecture

Solutions Builder is a client of Interchange. A person signs up, the hub
mints a principal, that principal creates a tenant, and the client installs
the app into that tenant — workflow definitions, skills, tools, roles and
grants — through the hub's own HTTP API. The desktop window, the tray, and
the loopback host ask that hub. They do not impersonate an owner, and they
do not run the nine-stage lifecycle as a state machine inside the host
process.

Each project's lifecycle runs as a deployment placed on an Interchange
workflow sidecar — a child process the hub spawns per allocation
(`workflow-deploy.ts`, `hub-mount.ts`). `lifecycle-run.ts` is a client of
that deployment: it fires the run, delivers gate commands to it as signals,
and derives where the run stands by folding the run's own committed events.

## Components

```
apps/hub/src/                    the desktop host: loopback API, the part of persistence that is not yet native, an optional in-process Interchange hub, sidecar placement
apps/web/                        the client: hub session, install, project open, the interface
apps/desktop/                    the native shell and tray
packages/embed-hub/src/          pglite + createApp/createAuth + process provisioner composition the host mounts
packages/solutions-builder/src/  the app package: the transition ledger, the lifecycle workflow generated from it, the specialist kit, the document format
packages/installer/src/          installs the app package into a tenant, driven by a hub transport the signed-in principal already holds
vendor/interchange/              the Interchange control plane, vendored under LGPL-2.1
```

**The app package** (`packages/solutions-builder`) is the product itself,
stated once: the ledger with every state, command, authority and transition
and the three forbidden cases; the Interchange lifecycle workflow generated
from it; the specialist kit and its prompts; and the document format the
client and the host both parse. It depends on nothing in the apps and on no
platform internals.

**The installer package** (`packages/installer`) does the installing: the
workspace tenant, its roles and grants, the seeded workflow definition, the
curated kit's skill assets, the tool packages the lifecycle carries, and the
per-project lifecycle deployment. Opening a project — its own tenant,
authority and credential delegation — is its `createProject`. It takes a hub
`Transport` (`@intx/hub-client`) already authenticated as the signed-in
principal, plus the two facts about sidecar placement only the host process
knows. It never reaches a database, a keychain or an Interchange internal
itself, and depends on nothing in `apps/`. The Interchange hub boots vanilla
(migrate, mount, serve). The client runs this package over the host's
`/hub` mount on first launch and after every credential change
(`apps/web/src/client.ts`); smokes still call the same package through
`scripts/host-install.ts`.

**The desktop host** (`apps/hub`) owns the loopback API the interface uses
for product commands, the local database when the hub is embedded, the
guard that admits a command against the ledger, and the providers. It is a
client of Interchange, not Interchange itself and not the lifecycle's
executor. The Interchange hub is Interchange's own hub app, either mounted
in this process (`hub-mount.ts` calling `@solutions-builder/embed-hub`) or
reached over HTTPS. Platform writes go through that hub's HTTP API
(`hub-client.ts`) — the same calls a hosted hub would serve. The composition
that binds pglite, `createApp`/`createAuth` and the process provisioner lives
in `packages/embed-hub`; `hub-mount.ts` supplies the host's handle, keychain
keys and sidecar paths. `hub-keys.ts` still imports `@intx/crypto` to expand
the signing seed.
`scripts/check-boundaries.ts` also allow-lists four more files as the
embedding layer — `db`, `schema`, `migrate` and `hub-migrate` — though none
of them currently has an `@intx` import at all; they reach Interchange's
data model through raw SQL and a shared drizzle schema instead.
`hub-migrations.ts` reaches the same layer by text-importing the vendored
`.sql` files directly (relative paths, not package specifiers), so it needs
no such exemption. Eight further files use only the platform's runtime
surface (`@intx/inference`, `@intx/inference-catalog`, `@intx/agent`,
`@intx/types`, `@intx/workflow`), which the same script treats as product
code rather than platform code, because using the platform's own inference
and workflow runtimes is the point of building on it: `agent-conversation`,
`catalog`, `failure`, `lifecycle-run`, `inference`, `live-drafts`,
`responses` and `workflow-seed`. Everything else in the host reaches
Interchange only through `hub-client.ts`. The host is also the only app
allowed to reach a provider. Run state moves in the workflow definition in
the app package, not in `command-dispatch.ts`. All three rules are enforced
by `check:boundaries`, not left to habit — this paragraph is drawn from its
`PLATFORM_PACKAGES`/`RUNTIME_PACKAGES` lists and `PLATFORM_FILE` allowlist,
cross-checked against every literal `@intx` import under `apps/hub/src`.

**The client** (`apps/web`) renders and asks. It holds a hub session the
browser obtained by signing up or signing in, reads and commands over the
host's loopback API (`client.ts`), and runs `install()` and `createProject()`
through `@solutions-builder/installer` over `/hub` as that same principal.
It never writes persistence itself. It imports the app package for names and
the document format, the installer package for those two calls, and never
the Interchange hub's own modules directly.

**The desktop shell** (`apps/desktop`) starts the host, opens the window on
the URL it prints, keeps a tray presence, and leaves the host running when
the window closes.

**What is not stored.** The decision waiting on a person is derived from the
run parked at its gate plus the ledger: title, consequence, required
authority and the exact versions it would freeze all follow from the run's
state and stage. A `human_wait` table used to copy this out at each gate; it
is gone (`decisions.ts`). The open question in a stage is read from the
thread: the specialist's turn that opened the round carries its questions as
mail, and the human turns after it are the answers (`questions.ts`). Neither
has a table, so neither can drift from the record it would restate. The
desktop notification is a ping off the parked run, never the record
(`notify.ts`).

## Signup, principal, tenant

Identity is Interchange's. Nothing in this product creates a parallel user
or permission system.

- **Signup** is a hub user. The client talks to the hub's auth routes
  through `/hub`. A `Set-Cookie` from the hub is forwarded, so the browser
  holds a hub session. Invite is the other way a user appears. The desktop
  handshake is the process door — after that, Interchange authz is policy.
- **A principal** is whatever acts: a person, a deployed agent, a workflow
  run. Signup (or invite) is what mints a user principal. Grants decide
  what that principal may do. A specialist speaks as a workflow principal;
  a run speaks as itself.
- **A tenant** owns data, credentials, assets and deployments. The
  signed-in principal creates the workspace tenant (`POST /api/tenants`);
  the hub makes them its principal. A project is a child tenant of that
  workspace; its policy and revision live in the tenant config, and its
  participants are principals holding roles there (`project-tenant.ts`).

`/hub` is a same-origin prefix strip onto the Interchange hub
(`hub-proxy.ts`). It forwards the browser's own cookies. It does not attach
a host session, strip `Set-Cookie`, or evaluate an allowlist. The signed-in
principal is the actor on every install, grant and deploy the client
drives.

## Workflows and tools

The hub deploys code. A workflow is a definition built from steps
(`defineWorkflow` in `@intx/workflow`): agent steps, actions, loops and
human gates on `awaitSignal`. The product's nine-stage lifecycle is one
such definition, generated from the ledger in the app package and installed
as the tenant's `project-lifecycle` row. The hub probes the source in a
sidecar, freezes a `workflow_definition`, and creates the anchor
`workflow_run`. Stage gates park on that run. The host admits a human
command against the ledger and delivers it as a named signal; it does not
step the machine.

Tools are packages a running step imports, not host RPCs. The lifecycle
carries `@intx/tools-posix` (a tool call parks until granted),
`@solutions-builder/tools-deck` (stage 5 renders a stakeholder deck in the
sidecar) and `@solutions-builder/tools-delivery` (stage 9 summarises a
manifest). Skills are hub assets of kind `skill`, each a `SKILL.md` the
kit already named. Directors, loops and actions come from the package's
`interchange.*` fields. Reach for a platform tool, skill or director
before new machinery.

Commands, approvals, audience decisions and their audit trail are turns in
a per-project ledger agent session (`command-ledger.ts`). The product's
run record (origin, source, cost approval, packet, checkpoint, why it
ended) is folded from the run mutations those turns carry (`runs.ts`);
where the run stands in the runtime is the hub's own workflow run on the
project's deployment (`lifecycle-run.ts`). Decision flags, worker
questions and their answers are fields on the ledger turn of the command
that raised them; a build attempt's events are turns of their own on the
same thread. The frozen build packet and the delivery manifest are
artifact versions, produced by the run that froze or delivered them;
acceptance is the `delivery.accept` turn.

## Embedded desktop versus remote hub

The same product runs against a hub embedded in the desktop process or a
hub hosted somewhere else. `SOLUTIONS_BUILDER_HUB_URL` is the switch.
Nothing above `hub-client.ts` can tell the difference.

**Embedded.** Absent the URL, the host mounts Interchange in-process over
pglite and places sidecars itself. `/hub` dispatches into the mounted Hono
app with no socket. This is the ordinary desktop.

**Remote.** With the URL, the host is a client of that hub over HTTPS. It
does not mount Interchange, does not place sidecars for that hub, and does
not invent a local identity. `GET /api/status` reports `hub.mode`,
`canPlaceSidecars` and `sidecarFingerprint`, so the client can tell which
side of the boundary it is on.

A deploy names where the bytes come from. Dependency-closure resolution,
version pinning and integrity are the platform's, identical across sources.

- **Local embed (desktop).** The installer writes the lifecycle into a
  workflow asset as a source tree whose workspace members are the vendored
  `@intx/*` packages, `@solutions-builder/app`, `@solutions-builder/tools-deck`
  and `@solutions-builder/tools-delivery`. Those bytes are a build-time
  snapshot (`workflow-closure-embed.ts`, generated by
  `scripts/embed-workflow-closure.ts`) so `apps/web` can install without
  `node:fs`. The sidecar lays a member out from the same git pack the
  workflow arrives in. Published `@intx/workflow` predates the loop signal
  relay the lifecycle relies on, so the deployed package must see the
  vendored revision; carrying that revision's `dist/` as members is the
  path that needs no registry.
- **Remote registry or asset.** A deploy can name an external npm registry,
  or a hub asset holding packed tarballs (`scripts/pack-registry-asset.ts`)
  or a source tree at a pinned commit. The resolver walks members and
  tarballs the same way. Hosted installs do not embed the closure in the
  web bundle; they name a source the hub can fetch.

Every write the host makes goes through a hub route now (CL-8075 closed
the last of them: registering a definition, sessions and conversation
turns, listing child tenants, reading a deployment's provisioner binding,
and writing/reading a workflow asset's source tree, all landed in
`vendor/interchange/packages/hub-api` — see
`vendor/interchange/PATCHES.md`). `createHubServer` is the one gap left
open on purpose: the vendored tree ships `@intx/hub-api`'s
`createApp`/`createAuth` and `@intx/hub-sessions`'s factories, not a
single entry point that accepts an injected pglite handle and keychain
keys the way this desktop embed needs, so `packages/embed-hub` still composes
those factories itself instead of calling one.

## What still lives beside Interchange

Everything the product records is meant to be one of two things: the
outcome of a workflow step, or a version of an artifact. Where neither
primitive can carry a field yet, a row stays in the `builder` schema with
the reason. The list is meant to shrink with every release, and nothing is
added to it without an upstream issue first. `local_provider` and
`human_wait` are two rows the list already lost: a local model endpoint is
now a catalog entry Interchange itself owns (`registerProviderCatalog` in
`catalog.ts`), and the parked-decision copy is gone, as described above
(`schema.ts`, `decisions.ts`).

| Table | Why it is not native yet |
| --- | --- |
| `artifact_node`, `artifact_edge` | `@corbits/artifacts` versions have no metadata or parent-version fields. Stage, lineage, exact hash and provenance ride here until that PR lands upstream. |
