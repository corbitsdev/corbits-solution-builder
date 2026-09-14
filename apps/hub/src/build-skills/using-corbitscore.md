`@corbits/*` packages are not on npm; install them from git under
github.com/corbitsdev. The repository is usually the package's own name:

    bun add github:corbitsdev/corbits-artifacts        # @corbits/artifacts
    bun add github:corbitsdev/corbits-oauth-core       # @corbits/oauth-core
    bun add github:corbitsdev/react-ui                 # @corbits/react-ui
    bun add github:corbitsdev/corbits-xai-provider     # @corbits/xai-provider
    bun add github:corbitsdev/corbits-codex-provider   # @corbits/codex-provider
    bun add github:corbitsdev/corbits-openai-responses # @corbits/openai-responses

Pin a ref (`#<sha-or-tag>`) when the plan needs reproducibility. For a
package not listed — memory, embeddings and more — find its repository
under the corbitsdev org; the repo name is not always the package name
verbatim.

The provisioning packages (`@corbits/process-provisioner`,
`@corbits/sandbox-sidecar`, `@corbits/error-sink`) live in
corbitsdev/workbench, unpublished. Vendor it under `vendor/workbench` —
the glob is already in `workspaces` — and record the revision in
`vendor/workbench/VENDORED_REVISION`, the same pin discipline as vendored
Interchange.

What each one replaces:

- `@corbits/artifacts` — the artifact store; do not hand-roll artifact
  tables.
- `@corbits/react-ui` — the component kit, rather than a generic set.
- `@corbits/oauth-core` — login orchestration, token storage boundaries,
  refresh, logout.
- `@corbits/*-provider` — the connector to a service; reach for it before
  writing an API client.
- `@corbits/process-provisioner` + `@corbits/sandbox-sidecar` — running
  sidecar allocations as child processes.
