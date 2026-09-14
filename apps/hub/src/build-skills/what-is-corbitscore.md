CorbitsCore is the corbitsdev package catalog (github.com/corbitsdev/*):
reusable product parts built on and around Interchange. Interchange is
the runtime; CorbitsCore is the reuse surface for what is built on it.

- `@corbits/artifacts` — a versioned artifact store: version, upload and
  download of the files a run produces.
- `@corbits/react-ui` — the component kit a generated interface draws
  from.
- `@corbits/oauth-core` — an OAuth flow end to end, so one is never
  written by hand.
- `@corbits/*-provider` (`xai-provider`, `codex-provider`,
  `openai-responses`) — connectors to individual services and providers.
- `@corbits/process-provisioner`, `@corbits/sandbox-sidecar`,
  `@corbits/error-sink` — the unpublished provisioning layer (in
  corbitsdev/workbench) that runs sidecar allocations as child processes.

The catalog is wider than this list — memory, embeddings and more live
under the corbitsdev org. Before writing a capability, check the catalog.
Where it genuinely lacks the thing, say so and scope it — a substitute
that pretends to be the primitive is worse than an admitted gap.
