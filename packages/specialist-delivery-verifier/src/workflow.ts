import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { deliveryVerifier } from "./index.ts";
import { deliver } from "@solutions-builder/tools-delivery/sidecar-bundle";

const AGENT = defineAgent({
  id: deliveryVerifier.id,
  systemPrompt: specialistPrompt(deliveryVerifier),
  tools: [deliver],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
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
