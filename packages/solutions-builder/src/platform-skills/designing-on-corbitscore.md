# designing-on-corbitscore

Reference material for when a brief actually needs the platform. Most
deliverables are ordinary product software — a CRM, a CLI, a service — and
should be designed as that, not forced into one of the shapes below.

**The common case: ordinary product software on the control plane.** The
product is built on the house stack (Bun, TypeScript, Hono, React + Vite +
React Router, TanStack Query, Better Auth, Postgres + Drizzle) and runs on
the Interchange hub's database as its control plane: the product's own
tables live in their own Postgres schema and foreign-key into the hub's
`tenant` and `principal` tables for tenancy and users, and login is the
hub's Better Auth. This gives durability, tenancy and room for agents or
workflows later, without the product being one. Do not add a workflow, an
agent or a bespoke permission system to a brief that only asked for an app.

Where a brief genuinely calls for agents, workflows, approvals or mail, it
takes one of these shapes instead:

- **A workflow deployment** — a package a hub deploys and runs. Agents are
  workflow definitions; the package's own directors, loops, actions and
  tools come from its `interchange.*` package.json fields.
- **A desktop host embedding the hub** — a host mounts the hub in-process
  and drives it for one operator. The hub and the sidecar are the
  platform's; the app is the client.
- **A hosted hub** — the same hub standing on the network, tenants and
  principals doing the multi-user work.

When building one of those agentic shapes:

- Define, don't orchestrate. An agent step, a drafting `loop`, a human gate
  on `awaitSignal` — all definition constructs, not bespoke machinery.
- Whatever acts acts under a principal — a person, a deployed agent, a
  workflow run — and grants gate it. Never build a second permission system.
- Skills, tools and directors are platform assets. Reach for them before
  new machinery.
- `apps/` holds clients that talk to a hub through `@intx/hub-client` or
  embed it; `packages/` holds what they share. The hub itself is never an
  app this build writes.
- Package what a hub would deploy so a deploy can name it: published to
  npm, or a git repository checked out at a pinned commit.
