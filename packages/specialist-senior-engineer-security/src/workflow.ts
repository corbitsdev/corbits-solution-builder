import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { seniorEngineerSecurity } from "./index.ts";

const AGENT = defineAgent({
  id: seniorEngineerSecurity.id,
  systemPrompt: specialistPrompt(seniorEngineerSecurity),
  tools: [],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
});

export default defineWorkflow({
  id: "sb-senior-engineer-security",
  triggers: [{ type: "mail", to: "sb-senior-engineer-security@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
