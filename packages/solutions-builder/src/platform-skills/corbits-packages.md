# corbits-packages

Corbits packages are reusable packages and solutions built by corbitsdev.
Interchange is the platform; these packages are not a separate platform.
Each is published on npm and installs with `bun add @corbits/<name>`; the
source is at github.com/corbitsdev/corbits-<name>.

- `@corbits/artifacts` — versioned file storage for what a run produces.
- `@corbits/memory` — shared memory and collective context for agents.
- `@corbits/embedding` — one API over every embedding provider.
- `@corbits/reranking` — multi-provider reranking in one call.
- `@corbits/mailbox` — an email inbox for the humans in an agent's loop.
- `@corbits/oauth-core` — PKCE + loopback OAuth login and token refresh.
- `@corbits/react-ui` — the component library a generated interface draws from.
- `@corbits/openai-responses` — the OpenAI Responses API as an inference adapter.
- `@corbits/xai-provider` — xAI as an inference provider.
- `@corbits/codex-provider` — OpenAI Codex (ChatGPT login) as an inference provider.

When a brief genuinely needs an agentic capability — memory, mailbox, oauth,
embeddings and the like — check the catalog before writing a new one. Where
it genuinely lacks the thing, say so and scope it — a substitute that
pretends to be the primitive is worse than an admitted gap. Ordinary product
code (screens, routes, schema, business logic) is simply written; this
catalog is not a checklist for it.
