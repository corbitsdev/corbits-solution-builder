# using-interchange

`@intx/*` is on npm, latest 0.4.0. A generated app installs the versioned
packages from the registry and pins them in its own `package.json`:

    bun add @intx/inference@0.4.0 @intx/agent@0.4.0 @intx/workflow@0.4.0

Two shapes, as examples.

**A CLI with an in-process agent.** `defineAgent` describes the agent;
`createAgent` runs it in this process against an inference source the app
builds from its own config; `agent.send` is one turn.

    import { createAgent, createDefaultDirectorRegistry, defineAgent } from "@intx/agent";

    const source = { id: "anthropic:claude-sonnet-5", provider: "anthropic",
      baseURL: "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: "claude-sonnet-5" };
    const def = defineAgent({ id: "summarizer", systemPrompt: "...", tools: [],
      capabilities: [], inference: { sources: [{ provider: "anthropic", model: source.model }] } });
    const agent = await createAgent(def, { source, storage, workdir, audit, authorize,
      directors: createDefaultDirectorRegistry() });
    const { reply } = await agent.send(input);

A workflow is a definition built from steps, run in-memory with
`@intx/workflow/runlocal` or durably with `@intx/workflow-host`:

    import { defineWorkflow, step, action, awaitSignal } from "@intx/workflow";

    export default defineWorkflow({
      id: "draft-report",
      triggers: [{ type: "manual" }],
      steps: {
        draft: step({ agent: draftingAgent }),
        review: awaitSignal({ name: "human-review", after: ["draft"] }),
        publish: action({ handler: "publish-report", after: ["review"] }),
      },
    });

Steps order by `after`. `step({ agent })` runs an agent; `action` names a
handler the package declares in `interchange.actions`; `awaitSignal` parks the
run on a human. The rest of the vocabulary: `loop`, `map`, `gate`,
`childWorkflow`, `sleep`, `onTrigger`, `escalation`.

**A web app with agents on the backend, the hub as its API.** The app's own
server handles its screens and data. Agents and workflows are packaged as a
workflow deployment the hub runs in a sidecar; the app starts a run and reads
its state through the hub's HTTP API, and users and permissions are the hub's
tenants, principals and grants. Tool runners for such agents come from
`@intx/tools-posix`, `@intx/tools-mail` and `@intx/tools-lsp`.
