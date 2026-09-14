# designing-on-corbitscore

A deliverable on the platform is normally one of three shapes:

- **A workflow deployment** — a package a hub deploys and runs. Agents are
  workflow definitions; the package's own directors, loops, actions and
  tools come from its `interchange.*` package.json fields.
- **A desktop host embedding the hub** — a host mounts the hub in-process
  and drives it for one operator. The hub and the sidecar are the
  platform's; the app is the client.
- **A hosted hub** — the same hub standing on the network, tenants and
  principals doing the multi-user work.

Whichever the shape:

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
