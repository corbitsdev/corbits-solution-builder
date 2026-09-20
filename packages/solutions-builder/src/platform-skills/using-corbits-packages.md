# using-corbits-packages

`@corbits/*` packages are not on npm. Install them from git — the repository
is usually `corbits-<package name>` under github.com/corbitsdev:

    bun add github:corbitsdev/corbits-artifacts    # @corbits/artifacts
    bun add github:corbitsdev/corbits-memory      # @corbits/memory
    bun add github:corbitsdev/corbits-embedding   # @corbits/embedding
    bun add github:corbitsdev/corbits-oauth-core  # @corbits/oauth-core
    bun add github:corbitsdev/react-ui            # @corbits/react-ui

The full list of packages is in the corbits-packages skill. Pin a ref
when the plan needs reproducibility:

    bun add github:corbitsdev/corbits-artifacts#<sha-or-tag>

The provisioning packages — `@corbits/process-provisioner`,
`@corbits/sandbox-sidecar`, `@corbits/error-sink` — live unpublished in
corbitsdev/workbench. Vendor it under `vendor/workbench` (the glob is
already in `workspaces`) and record the pin:

    git clone https://github.com/corbitsdev/workbench vendor/workbench
    git -C vendor/workbench rev-parse HEAD > vendor/workbench/VENDORED_REVISION
    bun install
