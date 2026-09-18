import { describe, expect, test } from "bun:test";
import { lifecycleEntrySource } from "./lifecycle-source.js";
import { NAME_STEP_ID, projectLifecycleDefinition } from "./project-lifecycle.js";

const SOURCE = { provider: "openai-compatible", model: "probe" };

describe("the naming step", () => {
  test("is absent from the in-process, gates-only definition", () => {
    const definition = projectLifecycleDefinition();
    expect(NAME_STEP_ID in (definition.steps as Record<string, unknown>)).toBe(false);
  });

  test("is absent from the rendered source when no offering exists", () => {
    const rendered = lifecycleEntrySource();
    expect(rendered).not.toContain("namerAgent");
    expect(rendered).not.toContain('steps[NAME] = step(');
  });

  test("runs the kit's namer against the run's opening problem statement, once an offering exists", () => {
    const rendered = lifecycleEntrySource({ source: SOURCE });
    expect(rendered).toContain(`const NAME = ${JSON.stringify(NAME_STEP_ID)};`);
    expect(rendered).toContain("const namerAgent = defineAgent({\n  id: \"namer\",");
    expect(rendered).toContain("steps[NAME] = step({");
    expect(rendered).toContain("agent: namerAgent");
    expect(rendered).toContain('input: { from: "trigger.payload.problemStatement" }');
  });

  test("carries no `after`, so it never gates stage 1", () => {
    const rendered = lifecycleEntrySource({ source: SOURCE });
    const nameStepBlock = rendered.slice(rendered.indexOf("steps[NAME] = step({"));
    const closing = nameStepBlock.indexOf("});");
    expect(nameStepBlock.slice(0, closing)).not.toContain("after:");
  });
});
