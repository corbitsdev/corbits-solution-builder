# Solutions Builder

Turns a half-formed problem into shipped software through nine human-gated
stages. A specialist agent drafts each stage; a person approves it against an
exact version. No agent holds approval authority.

It is a desktop app: a Tauri window and a tray icon over a persistent local
host. **The host is the product.** Closing the window does not stop it.
Already-authorised work continues to its next human gate, the wait is recorded,
and a desktop notification fires when it gets there.

## Getting started

Requires [Bun](https://bun.sh) 1.4 or newer (`engines.bun` in
[package.json](package.json)). Check with `bun --version`.

```bash
bun install
bun run dev
```

This builds the interface, starts the host, and opens it in your browser. When
it works you'll see the host print its launch URL, then a browser tab open on
it:

```
Solutions Builder host: http://127.0.0.1:PORT (api v1)
Solutions Builder launch URL: http://127.0.0.1:PORT/?token=...
```

The window opens on an empty workspace. Connect a provider in Settings — an
API key, a sign-in with ChatGPT or xAI, or a local endpoint that speaks the
OpenAI protocol — to draft with real agents, or in another terminal run:

```bash
bun run seed:demo
```

for a project already through stages 1 and 2, with a decision waiting at
stage 3.

To run the desktop shell instead of the browser (`bun run dev:desktop`) or
build it (`bun run desktop:build`), you also need the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust and
Xcode command line tools on macOS). `bun run check` is the full gate, run
before a commit; every script, including
these, is listed in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md#scripts).

## Read next

- [docs/PRODUCT.md](docs/PRODUCT.md): what it is, who it is for, the nine
  stages, the promises, and what is not finished.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the components, the layout of
  the repository, and how this sits on Interchange.
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): the stack, paths and
  environment variables, credentials, every script.
- [AGENTS.md](AGENTS.md): conventions for working in this repository,
  including the rules the code enforces.

## Licensing

`vendor/interchange/` is [Interchange](https://github.com/faremeter/interchange),
vendored at the revision in `vendor/interchange/VENDORED_REVISION` and licensed
under the [GNU LGPL v2.1](vendor/interchange/LICENSE). Local changes to it are
listed in `vendor/interchange/PATCHES.md`.
