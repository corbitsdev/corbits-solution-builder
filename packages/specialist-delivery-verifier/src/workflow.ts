import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { deliveryVerifier } from "./index.ts";
import { systemPrompt } from "./prompt.ts";
import SOURCE from "./inference-source.js";
import GUIDANCE from "./workspace-guidance.js";
import { deliver } from "@solutions-builder/tools-delivery/sidecar-bundle";

const AGENT = defineAgent({
  id: deliveryVerifier.id,
  systemPrompt: GUIDANCE ? `${systemPrompt}\n\n${GUIDANCE}` : systemPrompt,
  tools: [deliver],
  capabilities: [],
  inference: { sources: [SOURCE] },
});

export default defineWorkflow({
  id: "sb-stage-9",
  triggers: [{ type: "mail", to: "sb-stage-9@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
