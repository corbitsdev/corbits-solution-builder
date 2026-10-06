import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { seniorEngineerApplication } from "./index.ts";

const AGENT = defineAgent({
  id: seniorEngineerApplication.id,
  systemPrompt: specialistPrompt(seniorEngineerApplication),
  tools: [],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
});

export default defineWorkflow({
  id: "sb-senior-engineer-application",
  triggers: [{ type: "mail", to: "sb-senior-engineer-application@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
