# corbits-packages

`@corbits/*` packages are published on npm and install with `bun add @corbits/<name>`; source at github.com/corbitsdev/corbits-<name>. Every package below is on npm as of 2026-10-02 at the version shown; a name not listed here is not a package a deliverable can build on.

Mount onto a hub (an embedded host counts):

- `@corbits/artifacts` 0.2.0 — artifacts, versions and uploads with a
  pluggable ContentStore, mountable onto any Interchange host.
- `@corbits/mailbox` 0.2.0 — a native Interchange mailbox for human
  principals, mountable onto any Interchange host.
- `@corbits/memory` 0.2.0 — mountable memory add/search/list SDK for
  Interchange hubs, with a resident distiller.
- `@corbits/cron` 0.2.1 — cron schedules for an Interchange hub: grant-gated
  schedule routes plus a ticker that turns a due row into run-trigger mail.
- `@corbits/webhooks` 0.2.0 — receive signed webhooks (Slack, Standard
  Webhooks, bearer) and start a workflow run.
- `@corbits/agent-token` 0.2.0 — bearer tokens a deployed agent presents when
  it calls back into its Interchange hub: mint/revoke routes and a verifying
  Hono middleware.

In-process, no hub needed:

- `@corbits/embedding` 0.2.0 — embedding client for OpenAI-compatible
  `/v1/embeddings` endpoints, on the Interchange inference primitives.
- `@corbits/reranking` 0.2.0 — cross-encoder rerank client with TEI,
  Cohere/Jina and Voyage adapters, on the Interchange inference primitives.
- `@corbits/system-one` 0.2.0 — typed-decision evaluation client for System
  One (Jev-class) models: arktype question/decision schemas, endpoint
  configuration with gateway override, timeout/fallback semantics.
- `@corbits/oauth-core` 0.3.0 — provider-agnostic OAuth 2.0
  authorization-code + PKCE login for desktop/CLI hosts.
- `@corbits/credential-http` 0.1.0 — origin-pinned HTTP credential providers
  for Interchange: any header, x-api-key, raw Authorization.
- `@corbits/react-ui` 0.3.0 — React components for agent and workflow
  surfaces; the component library a generated interface draws from.

Inference adapters:

- `@corbits/openai-responses` 0.2.1 — Interchange ProviderAdapter for the
  OpenAI Responses API wire protocol: quirks-based vendor configuration, SSE
  and non-streaming parsing, reasoning signature replay.
- `@corbits/codex-provider` 0.1.2 — OpenAI Codex (Login with ChatGPT) as an
  Interchange inference provider, with OAuth token exchange and a
  Responses-protocol adapter.
- `@corbits/xai-provider` 0.1.1 — xAI (Grok) OAuth config, token mapping, and
  a Responses adapter for xAI's CLI chat proxy.
- `@corbits/ollama-adapter` 0.2.0 — Ollama as an Interchange inference
  provider: OpenAI-compatible and Anthropic messages factories, one reasoning
  setting, think-tag stripping, inline tool JSON repair.

Not on npm, and not for a generated stack: `@corbits/embedded-host`,
`@corbits/embed-hub` and `@corbits/keychain` are Solution Builder's own
workspace packages, the process this tool itself runs in. A deliverable that
needs an embedded hub is built on `@intx/*` directly.
