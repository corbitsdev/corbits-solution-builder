# Solutions Builder

Turns a half-formed problem into shipped software through nine human-gated
stages. A specialist agent drafts each stage; a person approves it against an
exact version. No agent holds approval authority.

It is a desktop app: a Tauri window and a tray icon over a persistent local
host. **The host is the product.** Closing the window does not stop it.
Already-authorised work continues to its next human gate, the wait is recorded,
and a desktop notification fires when it gets there.

## Run it

Requires [Bun](https://bun.sh) 1.4 or newer. The desktop window also needs the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust and
Xcode command line tools on macOS).

```bash
bun install
bun run dev            # host from source, opens in your browser, rebuilds on edit
```

Then connect a provider in Settings: an API key, a sign-in with ChatGPT or xAI,
or a local endpoint that speaks the OpenAI protocol. Everything else works
without one, and `bun run seed:demo` gives you a project with a decision
waiting.

Other ways to run it:

```bash
bun run dev:desktop    # the same, inside the native window
bun run dev:fresh      # the native window on a brand-new, empty workspace
bun run desktop:build  # .app and .dmg (unsigned)
bun run check          # every invariant checker and smoke, the gate before a commit
```

## Read next

- [docs/PRODUCT.md](docs/PRODUCT.md): what it is, who it is for, the nine
  stages, the promises, and what is not finished.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the components, the three
  enforced rules, how a stage runs, and how this sits on Interchange.
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): the stack, paths and
  environment variables, credentials, every script.
- [AGENTS.md](AGENTS.md): conventions for working in this repository.

## How it is put together

```
apps/hub/src/                    the host: loopback API, guard, engine, persistence, the embedded Interchange hub
apps/web/                    the client
apps/desktop/                the native shell and tray
packages/solutions-builder/src/  the app package: the transition ledger, the workflows generated from it,
                             the specialist kit, the document format
vendor/interchange/          the Interchange control plane, vendored (LGPL-2.1)
```

Three rules are enforced by `bun run check` rather than documented:

- **One state machine.** The ledger is the single machine-readable contract,
  the guard is its only enforcement point, and the engine is the only writer of
  a run's state. The Interchange workflow definitions are generated from it.
- **One direction.** The app package depends on nothing in the apps. Only the
  hub may reach a provider. The client never imports the hub or touches
  persistence.
- **Exact versions.** An approval names a version and the hash the approver
  saw. If the bytes moved, the approval is refused.

## Licensing

`vendor/interchange/` is [Interchange](https://github.com/faremeter/interchange),
vendored at the revision in `vendor/interchange/VENDORED_REVISION` and licensed
under the [GNU LGPL v2.1](vendor/interchange/LICENSE). Local changes to it are
listed in `vendor/interchange/PATCHES.md`.
