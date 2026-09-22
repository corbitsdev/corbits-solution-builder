/**
 * CL-8861: the one rubric for choosing which Interchange layer a deliverable
 * uses. Shared by every stage-4-to-8 role that touches the stack decision —
 * it replaces the four separate "house stack" paragraphs that used to live
 * in `kit.ts`. The person never picks a layer; they see only the
 * plain-language "How it will actually run" section built from the
 * `StackRecord` the Architect emits (see `stack.ts`).
 */
export const STACK_RUBRIC = `
## The stack rubric

### Step 1 — mode: the smallest that meets the requirements

Each step up must cite the requirement id that rules out the one below.

1. **plain** — no Interchange.
2. **inference** — \`@intx/inference\` only; the app builds \`InferenceSource[]\`
   itself, credentials from local config or \`@corbits/keychain\`.
3. **agent** — \`createAgent\` (\`@intx/agent\`) + \`agent.send\` in-process, tool
   bundles in the \`AgentDefinition\`; no transport, a direct call.
4. **local-workflow** — \`runLocal\` (\`@intx/workflow\`); needs \`authorize\` and
   \`hasUpstreamSignalResolver\`. Can be fully non-agentic: \`action\`, \`gate\`,
   \`awaitSignal\`, \`sleep\`, \`map\`, \`loop\`, \`childWorkflow\`, \`onTrigger\` need no
   agent; only \`step\` runs one, wire \`invokeStep\` to \`createAgent\` only when
   there are agent steps. Does not imply modes 2 or 3. In-memory; nothing
   survives a restart.
5. **durable-workflow** — adds \`@intx/workflow-host\`: supervisor with
   crash-respawn/drain, signed-IPC child processes, durable repo/blob/mailbox
   adapters.
6. **hub** — default whenever multi-person, multi-tenant, expected to move to
   the cloud later, or needs delegated credentials, remote/sandboxed agents,
   capability approval, audit, or mail between principals. \`hubPlacement\`:
   "embedded" (\`@corbits/embedded-host\` + \`@corbits/embed-hub\` +
   \`@corbits/process-provisioner\` on one machine, pglite + loopback + keychain)
   or "cloud". Embedded moves to cloud later without a mode swap.

Seams that change between local and hub (name each one the plan uses):
\`WorkflowRuntimeEnv\`, \`invokeStep\`, \`authorize\`, \`MessageTransport\`,
\`ContextStore\`, model sources/credentials.

### Step 2 — capabilities: add only when a requirement names the need

L = in-process, no hub. H = mounts onto a hub (embedded-host counts).

- Models: \`@intx/inference-catalog\` (L), \`@corbits/inference-catalog\` (L),
  \`@corbits/inference-settings\` (H), \`@corbits/provider-pricing\` (L),
  \`@corbits/catalog-tools\` (L), adapters — \`@corbits/ollama-adapter\`,
  \`@corbits/openai-responses\`, \`@corbits/codex-provider\`,
  \`@corbits/xai-provider\` (L)
- Classification: \`@corbits/system-one\` (L)
- Retrieval: \`@corbits/embedding\` (L), \`@corbits/reranking\` (L)
- Knowledge: \`@corbits/knowledge-engine\` (H) + \`@corbits/linear\` source
- Memory: \`@corbits/memory\` (H); \`memory-hub\`/\`memory-tools\` for workflow
  access; \`@corbits/mem0\`, \`@corbits/supermemory\` store adapters
- Artifacts/files: \`@corbits/artifacts\` (H) + \`artifacts-hub\`,
  \`turn-artifacts\`, \`gotenberg-render\`
- Mail/inbox: \`@corbits/mailbox\`/\`mailbox-core\` (H), \`inbox\`;
  \`@intx/tools-mail\`, \`harness\`, \`mailbox\`, \`mime\`
- Scheduling: \`@corbits/cron\` (H), \`@corbits/routines\`
- Skills: \`@corbits/skills\` (H), \`skills-tools\`, \`tools-skills\`
- Agent tools (L): \`tools-posix\`, \`tools-lsp\`, \`@corbits/web-search-tools\`,
  \`github-tools\`, \`reddit-tools\`, \`connections-tools\`, \`capability-tools\`,
  \`deferred-tools\`
- Approvals: \`@corbits/approvals\` (H), \`@intx/authz\`
- Images: \`@corbits/image\` (L)
- Evals/analytics: \`@corbits/evals\`, \`@corbits/analytics-core\` (H)
- Desktop/CLI auth: \`@corbits/oauth-core\` (L)
- Local secrets: \`@corbits/keychain\` (L)
- Logging: \`@intx/log\` + \`@corbits/error-sink\`
- Tests only: \`@intx/inference-testing\`, \`@corbits/mocks\`

\`@corbits/*\` is the extension surface: mount it, never customize the hub or
vendor it.

Anything not forced by a requirement is a deferred option, never a build
item.
`.trim();
