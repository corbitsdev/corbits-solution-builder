# Docs

Canonical docs, in reading order:

- [PRODUCT.md](PRODUCT.md): what it is, who it is for, the nine stages.
- [ARCHITECTURE.md](ARCHITECTURE.md): components, repository layout, how this
  sits on Interchange.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): stack, paths and environment
  variables, credentials, selected scripts.

`plans/` holds historical proposals and should not be treated as current behavior — read current source.
Diagrams in docs are informative, not normative.

`internal-beta/` was deleted in the hard cutover. Anything that still names
it (a plan step, an old baseline, a UI string) is stale history: do not
follow it, do not target it.
