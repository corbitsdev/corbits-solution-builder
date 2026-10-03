# designing-on-interchange

The shapes Interchange offers, smallest first. The stack rubric in the
Architect's own instructions is what chooses between them.

- **Local libraries.** The app imports `@intx/inference`, `@intx/agent` or
  `@intx/workflow` and runs them in its own process: a CLI, a desktop app, a
  single-user service. No hub, no sidecar; credentials from the app's own
  config.
- **Durable local.** The same, with `@intx/workflow-host`: a run survives a
  restart, and a human gate can wait for days.
- **Control plane.** A hub (an HTTP API over Postgres) owns tenants,
  principals, credentials, assets and deployments, and runs agents and
  workflows in sidecars isolated from each other and from the app. The app
  is a client of the hub. Several people, several tenants, delegated
  credentials, approvals, audit and isolation of what an agent can reach
  are what this shape provides.

How the platform's pieces fit, whichever shape:

- An agent, a workflow or an approval gate is a definition construct: an
  agent `step`, a drafting `loop`, a gate on `awaitSignal`.
- On the control plane, whatever acts acts as a principal (a person, a
  deployed agent, a workflow run), and grants decide what it may do. The
  hub's tenants and principals are the user and permission model.
- A hub deploys a package it can name: published to npm, or a git repository
  checked out at a pinned commit.
