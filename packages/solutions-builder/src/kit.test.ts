import { describe, expect, test } from "bun:test";
import { agentById, agentFor } from "./kit.js";
import { STACK_BLOCK_SHAPE } from "./stack.js";
import { SELECTABLE_TARGETS } from "./targets.js";

describe("Experience designer prompt", () => {
  test("requires the mockup to fit the width it is read at, not a wide monitor", () => {
    const designer = agentById("experience-designer");
    expect(designer).toBeDefined();
    const prompt = designer!.system;
    expect(prompt).toContain("The mockup fits the width it is read at.");
    expect(prompt).toContain("any width from 402px up");
    expect(prompt).toContain("minmax(0, 1fr)");
    expect(prompt).toContain("nothing clipped at the right edge");
    expect(prompt).toContain("scrolls inside its own panel");
  });

  test("asks every desktop or phone screen to lay out at both review widths (#417)", () => {
    const prompt = agentById("experience-designer")!.system;
    expect(prompt).toContain("Every desktop or phone screen lays out at both widths.");
    expect(prompt).toContain("1280px and at 402px");
    expect(prompt).toContain("@media (max-width: 640px)");
    expect(prompt).toContain("Nothing scrolls horizontally at\n  402px.");
  });
});

// #617: the gate at Build plan reads a fenced record under "## Stack"; an
// Architect told only the heading writes prose there, and no plan passes.
describe("Architect prompt", () => {
  test("gives the Stack block's fence and its exact shape", () => {
    const prompt = agentById("architect")!.system;
    expect(prompt).toContain("exactly one fenced block, opened with\n```json stack");
    expect(prompt).toContain(STACK_BLOCK_SHAPE);
    expect(prompt).toContain("Do not add,\nrename or leave out a field");
  });

  test("asks for cited entries, and the whole block in every version", () => {
    const prompt = agentById("architect")!.system;
    expect(prompt).toContain("Every entry's `cites` array is non-empty");
    expect(prompt).toContain("even when nothing in it changed");
  });
});

// #354: the estimator priced the stack but never the delivery targets, and
// claimed stage 8, whose specialist is the build-supervisor.
describe("Estimator prompt", () => {
  test("serves stage 7 only; stage 8 belongs to the build-supervisor", () => {
    expect(agentById("estimator")!.stages).toEqual([7]);
    expect(agentFor(7).id).toBe("estimator");
    expect(agentFor(8).id).toBe("build-supervisor");
  });

  test("keeps its prompt key: prompt text changed, no versioning mechanism exists for that", () => {
    expect(agentById("estimator")!.promptKey).toBe("sb-prompt-estimator-v1");
  });

  test("prices the plan's declared targets, never one it chooses itself", () => {
    const prompt = agentById("estimator")!.system;
    expect(prompt).toContain("Price the plan's declared `targets` entries");
    expect(prompt).toContain("the same entries stage 8\npasses to `publish_workspace`");
    expect(prompt).toContain("never a target you choose yourself");
    expect(prompt).toContain('Price the stack the plan\'s "## Stack" block records');
  });

  test("names every picker candidate with whether the platform exercises it", () => {
    const prompt = agentById("estimator")!.system;
    for (const entry of SELECTABLE_TARGETS) {
      expect(prompt).toContain(entry.target);
      expect(prompt).toContain(entry.label);
      expect(prompt).toContain(entry.verified ? "exercised" : "not exercised");
    }
  });

  test("requires one Forecast line per target, with a named human cost that is never zero", () => {
    const prompt = agentById("estimator")!.system;
    expect(prompt).toContain("Then one line per declared target");
    expect(prompt).toContain("whether the platform exercises it");
    expect(prompt).toContain("names its human verification cost instead; that cost is never zero");
  });

  test("asks which target the approval is for when several targets price differently", () => {
    const prompt = agentById("estimator")!.system;
    expect(prompt).toContain("when the plan declares more than one target and\nthe figure differs materially by target, ask which target the approval is for");
  });
});
