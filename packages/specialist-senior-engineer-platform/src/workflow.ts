import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { seniorEngineerPlatform } from "./index.ts";

const AGENT = defineAgent({
  id: seniorEngineerPlatform.id,
  systemPrompt: specialistPrompt(seniorEngineerPlatform),
  tools: [],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
});

export default defineWorkflow({
  id: "sb-senior-engineer-platform",
  triggers: [{ type: "mail", to: "sb-senior-engineer-platform@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
