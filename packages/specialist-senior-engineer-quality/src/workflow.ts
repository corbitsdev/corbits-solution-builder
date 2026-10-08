import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { seniorEngineerQuality } from "./index.ts";

const AGENT = defineAgent({
  id: seniorEngineerQuality.id,
  systemPrompt: specialistPrompt(seniorEngineerQuality),
  tools: [],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
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
