# using-corbits-packages

`@corbits/*` packages are published on npm. Install them the ordinary way:

    bun add @corbits/artifacts
    bun add @corbits/memory
    bun add @corbits/embedding
    bun add @corbits/oauth-core
    bun add @corbits/react-ui

The full list, with versions and what each does, is in the corbits-packages
skill; a name not on that list is not a package. A deliverable pins exact
versions in its own `package.json` — the stage 7 freeze names them, and the
build installs what the freeze names:

    bun add @corbits/artifacts@0.2.0

Each package's source is at github.com/corbitsdev/corbits-<package name>
(for example corbitsdev/corbits-artifacts); the npm package is what a
deliverable depends on, never a git checkout vendored into its tree.
