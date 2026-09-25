import { describe, expect, test } from "bun:test";
import type { Provider } from "../../client.ts";
import { currentInference, inferenceOptions, orderLeadingWith } from "./inference-options.ts";

function provider(over: Partial<Provider>): Provider {
  return {
    id: "mp", providerId: "x", label: "X", kind: "api_key", baseUrl: null, status: "ready", statusDetail: null,
    models: ["m1"], active: true, priority: 0, hasCredential: true, validatedAt: null, selectedModel: "m1",
    enabledModels: ["m1"], selectedOfferingId: "off-1", ...over,
  };
}

const PROVIDERS = [
  provider({ id: "mp-a", label: "Anthropic", selectedModel: "claude-fable-5-1", selectedOfferingId: "off-a" }),
  provider({ id: "mp-o", label: "OpenAI", selectedModel: "gpt-5.5", selectedOfferingId: "off-o" }),
  provider({ id: "mp-x", label: "xAI", selectedModel: null, selectedOfferingId: null }),
  provider({ id: "mp-e", label: "Broken", status: "error" }),
];

describe("inference options", () => {
  test("one option per runnable settings row, in settings order, labelled provider · model", () => {
    expect(inferenceOptions(PROVIDERS).map((option) => option.label)).toEqual(["Anthropic · claude-fable-5-1", "OpenAI · gpt-5.5"]);
    expect(inferenceOptions(PROVIDERS)[1]).toMatchObject({ providerRowId: "mp-o", offeringId: "off-o" });
  });
  test("the current option is matched by provider label and model", () => {
    const options = inferenceOptions(PROVIDERS);
    expect(currentInference({ providerLabel: "OpenAI", canonicalName: "gpt-5.5" }, options)?.providerRowId).toBe("mp-o");
    expect(currentInference({ providerLabel: "OpenAI", canonicalName: "gpt-4" }, options)).toBeNull();
    expect(currentInference(null, options)).toBeNull();
  });
  test("choosing an option is the settings order with that row moved to the top", () => {
    expect(orderLeadingWith(PROVIDERS, "mp-o")).toEqual(["mp-o", "mp-a", "mp-x", "mp-e"]);
  });
});
