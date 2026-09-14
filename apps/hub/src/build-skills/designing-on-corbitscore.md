A deliverable on the platform is normally one of three shapes:

- **A workflow deployment with agent steps** — a workflow package a hub
  deploys and runs. Agents are workflow definitions; the package's own
  directors, loops, actions and tools come from its `interchange.*`
  package.json fields. At deploy time the capability walk computes the
  grants the run requires and the operator's approval gates them.
- **A desktop host embedding the hub** — a Tauri or Bun host mounts the
  hub in-process and drives it for one operator. The hub and the sidecar
  are the platform's; the app is the client.
- **A hosted hub** — the same hub standing on the network, tenants and
  principals doing the multi-user work.

Whichever the shape:

- Authority is the platform's. Tenants own data and credentials;
  principals — people and agents — act under grants the hub evaluates. Do
  not model a parallel user or permission system.
- Agents are workflows. A persistent agent step, a drafting loop, a human
  gate that parks on `awaitSignal` — definition constructs, not bespoke
  orchestration.
- Skills, tools and directors are platform assets. A skill is a SKILL.md
  the hub mounts into a session as `skills/<name>/`; a tool package ships
  through `interchange.tools`; a director (`defineDirector`) shapes an
  agent's behaviour. Reach for them before new machinery.
- `apps/` holds clients — interfaces and hosts that talk to a hub through
  `@intx/hub-client` or embed it. `packages/` holds what they share. The
  hub itself is never an app this build writes.
- Package what a hub would deploy so a deploy can name it: published to
  npm, or a git repository it can check out at a pinned commit.

Reference builds: Solutions Builder is a desktop host embedding the hub
whose nine-stage lifecycle deploys as a workflow; the agent-flight-alpha
spike is the proven Tauri host plus Bun sidecar pattern. Both are this
platform, used plainly.
