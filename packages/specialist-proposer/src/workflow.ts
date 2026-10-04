import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { proposer } from "./index.ts";
import { systemPrompt } from "./prompt.ts";
import SOURCE from "./inference-source.js";

const AGENT = defineAgent({
  id: proposer.id,
  systemPrompt,
  tools: [],
  capabilities: [],
  inference: { sources: [SOURCE] },
});

export default defineWorkflow({
  id: "sb-stage-3",
  triggers: [{ type: "mail", to: "sb-stage-3@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
