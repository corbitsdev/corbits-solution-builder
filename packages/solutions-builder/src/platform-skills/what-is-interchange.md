# what-is-interchange

Interchange is the platform runtime: a hub that deploys and runs work.
Source: github.com/faremeter/interchange, packages scoped `@intx/*`.

- **Hub** — the control plane: an HTTP API over PostgreSQL owning tenants,
  principals, credentials, assets, sessions and deployments.
- **Tenants and principals** — a tenant owns data and credentials. A
  principal is whatever acts: a person, a deployed agent, a workflow run.
  Grants decide what a principal may do. Never model a parallel user or
  permission system.
- **Workflows** — the unit of deployed work: a durable, resumable run that
  can park on a human's signal. An agent is deployed as a workflow
  definition, not a row in a table.
- **Sidecars** — the processes that execute work: they connect to the hub
  and run sessions.
- **Assets** — versioned content the hub serves; a skill mounts into a
  session as `skills/<name>/`.
- **Credentials** — tenant-owned rows, sealed at rest; a sidecar sees
  plaintext only to authenticate.
- **Inference** — provider-agnostic: Anthropic, OpenAI and Google GenAI
  adapters behind one streaming interface.
