import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { seniorEngineerQuality } from "./index.ts";
import { systemPrompt } from "./prompt.ts";
import SOURCE from "./inference-source.js";
import GUIDANCE from "./workspace-guidance.js";

const AGENT = defineAgent({
  id: seniorEngineerQuality.id,
  systemPrompt: GUIDANCE ? `${systemPrompt}\n\n${GUIDANCE}` : systemPrompt,
  tools: [],
  capabilities: [],
  inference: { sources: [SOURCE] },
});

export default defineWorkflow({
  id: "sb-senior-engineer-quality",
  triggers: [{ type: "mail", to: "sb-senior-engineer-quality@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
