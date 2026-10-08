import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import { INFERENCE_SOURCE, specialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { requirementsAuthor } from "./index.ts";

const AGENT = defineAgent({
  id: requirementsAuthor.id,
  systemPrompt: specialistPrompt(requirementsAuthor),
  tools: [],
  capabilities: [],
  inference: { sources: [INFERENCE_SOURCE] },
});

export default defineWorkflow({
  id: "sb-stage-6",
  triggers: [{ type: "mail", to: "sb-stage-6@solutions-builder.local" }],
  steps: {
    run: step({
      agent: AGENT,
      input: { from: "trigger.payload" },
      drainBehavior: "wait",
      triggers: "unbounded",
    }),
  },
});
