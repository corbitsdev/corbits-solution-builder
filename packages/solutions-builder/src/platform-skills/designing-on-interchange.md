# designing-on-interchange

Interchange offers a range of shapes. Pick the smallest one the requirements
force; the stack rubric names the modes and the requirement that steps up.

- **Local libraries.** The app imports `@intx/inference`, `@intx/agent` or
  `@intx/workflow` and runs them in its own process: a CLI, a desktop app, a
  single-user service. No hub, no sidecar; credentials from the app's own
  config. The simplest shape, and the default for an app one person runs.
- **Durable local.** The same, with `@intx/workflow-host` so a run survives a
  restart and a human gate can wait for days.
- **Control plane.** A hub (an HTTP API over Postgres) owns tenants,
  principals, credentials, assets and deployments, and agents and workflows
  run in sidecars the hub isolates from each other and from the app. The app
  is a client of the hub. This is the shape for several people, several
  tenants, delegated credentials, approvals, audit, or maximum isolation of
  what an agent can reach.

Whichever shape, an ordinary product stays an ordinary product: its own
screens, routes, schema and logic, written plainly. An agent, a workflow or an
approval gate appears only where a requirement names the need, and then it is
defined with the platform's constructs — an agent step, a drafting `loop`, a
gate on `awaitSignal` — not orchestrated by hand. On the control plane,
whatever acts acts under a principal and grants gate it; never build a second
user or permission system beside the hub's.

Package what a hub would deploy so a deploy can name it: published to npm, or
a git repository checked out at a pinned commit.
