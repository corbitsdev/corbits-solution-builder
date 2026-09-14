Interchange is the platform runtime: a hub that deploys and runs work,
not a library of parts assembled by hand. Source:
github.com/faremeter/interchange (the `@intx/*` packages).

- **Hub** — the control plane: an HTTP API (`@intx/hub-api`) over
  PostgreSQL (`@intx/db`) owning tenants, principals, credentials,
  assets, sessions and deployments. One hub serves many tenants.
- **Tenants, principals, grants** — a tenant owns data and credentials; a
  principal — a person or an agent — acts under grants the hub evaluates
  (`@intx/authz`). Authority is the platform's; never model a parallel
  user or permission system.
- **Workflows and runs** — the unit of deployed work (`@intx/workflow`):
  a durable, resumable run that can park on a human's signal. An agent is
  deployed as a workflow definition, not a row in a table.
- **Sidecars** — the processes that execute allocations: they connect to
  the hub, receive work, run sessions. Placement is a provisioner's job.
- **Assets** — versioned content the hub serves; a skill mounts into a
  session as `skills/<name>/`, tool packages deploy through the same
  machinery.
- **Credentials** — tenant-owned rows, sealed at rest; a sidecar sees
  plaintext only to authenticate.
- **Inference** — provider-agnostic (`@intx/inference`): Anthropic,
  OpenAI and Google GenAI adapters behind one streaming interface.
