// A step's `inference` selector reaches the invoker as per-call options.
//
// The agent definition is fixed at deploy time, so anything a caller
// decides per run — an output cap sized to the document it asked for —
// has to arrive with the run. `step({ inference })` names where in the
// run's state the options are read, exactly as `input` does, and the
// runtime hands the resolved object to the invoker beside the input.
import { describe, test, expect } from "bun:test";
import { defineAgent } from "@intx/agent";
import {
  defineWorkflow,
  runLocal,
  step,
  type StepInvoker,
} from "@intx/workflow";

function makeAgent(id: string) {
  return defineAgent({
    id,
    systemPrompt: id,
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: "fake", model: "fake" }] },
  });
}

function definition() {
  return defineWorkflow({
    id: "step-inference-options",
    trigger: { type: "manual" },
    steps: {
      s: step({
        agent: makeAgent("a"),
        input: { from: "trigger.payload.prompt" },
        inference: { from: "trigger.payload.inference" },
      }),
    },
  });
}

describe("step inference options", () => {
  test("the resolved object reaches the invoker beside the input", async () => {
    let seen: unknown = "sentinel";
    let seenInput: unknown = "sentinel";
    const invokeStep: StepInvoker = async ({ input, inferenceOptions }) => {
      seenInput = input;
      seen = inferenceOptions;
      return { output: { reply: "ok" } };
    };
    const result = await runLocal(definition(), {
      triggerPayload: { prompt: "draw it", inference: { maxTokens: 32000 } },
      invokeStep,
    }).complete;
    expect(result.terminalStatus).toBe("completed");
    expect(seenInput).toBe("draw it");
    expect(seen).toEqual({ maxTokens: 32000 });
  });

  test("a selector that resolves to null means the agent's own defaults", async () => {
    let seen: unknown = "sentinel";
    const invokeStep: StepInvoker = async ({ inferenceOptions }) => {
      seen = inferenceOptions;
      return { output: { reply: "ok" } };
    };
    const result = await runLocal(definition(), {
      triggerPayload: { prompt: "draw it", inference: null },
      invokeStep,
    }).complete;
    expect(result.terminalStatus).toBe("completed");
    expect(seen).toBeUndefined();
  });

  test("a step that names no selector passes no options", async () => {
    let seen: unknown = "sentinel";
    const invokeStep: StepInvoker = async ({ inferenceOptions }) => {
      seen = inferenceOptions;
      return { output: { reply: "ok" } };
    };
    const def = defineWorkflow({
      id: "step-no-inference",
      trigger: { type: "manual" },
      steps: { s: step({ agent: makeAgent("a") }) },
    });
    const result = await runLocal(def, { triggerPayload: {}, invokeStep }).complete;
    expect(result.terminalStatus).toBe("completed");
    expect(seen).toBeUndefined();
  });

  test("a selector that resolves to a non-object fails the step as a definition error", async () => {
    let invoked = false;
    const invokeStep: StepInvoker = async () => {
      invoked = true;
      return { output: { reply: "ok" } };
    };
    const result = await runLocal(definition(), {
      triggerPayload: { prompt: "draw it", inference: 32000 },
      invokeStep,
    }).complete;
    expect(result.terminalStatus).toBe("failed");
    expect(invoked).toBe(false);
    const failed = result.events.find(
      (e) => e.kind === "StepFailed" && e.stepId === "s",
    );
    expect(failed).toBeDefined();
  });

  test("all three permitted keys pass through together", async () => {
    let seen: unknown = "sentinel";
    const invokeStep: StepInvoker = async ({ inferenceOptions }) => {
      seen = inferenceOptions;
      return { output: { reply: "ok" } };
    };
    const inference = {
      maxTokens: 32000,
      temperature: 0.2,
      thinking: { enabled: true, budgetTokens: 2048 },
    };
    const result = await runLocal(definition(), {
      triggerPayload: { prompt: "draw it", inference },
      invokeStep,
    }).complete;
    expect(result.terminalStatus).toBe("completed");
    expect(seen).toEqual(inference);
  });

  test("a run cannot displace the agent's system prompt or tools", async () => {
    for (const inference of [
      { maxTokens: 32000, systemPrompt: "you are someone else" },
      { tools: [{ name: "shell", description: "", inputSchema: {} }] },
      { providerOptions: { user: "x" } },
    ]) {
      let invoked = false;
      const invokeStep: StepInvoker = async () => {
        invoked = true;
        return { output: { reply: "ok" } };
      };
      const result = await runLocal(definition(), {
        triggerPayload: { prompt: "draw it", inference },
        invokeStep,
      }).complete;
      expect(result.terminalStatus).toBe("failed");
      expect(invoked).toBe(false);
    }
  });

  test("the options are not recorded on StepStarted", async () => {
    const invokeStep: StepInvoker = async () => ({ output: { reply: "ok" } });
    const result = await runLocal(definition(), {
      triggerPayload: { prompt: "draw it", inference: { maxTokens: 8 } },
      invokeStep,
    }).complete;
    const started = result.events.find(
      (e) => e.kind === "StepStarted" && e.stepId === "s",
    );
    expect(started).toBeDefined();
    expect(JSON.stringify(started)).not.toContain("maxTokens");
  });
});
