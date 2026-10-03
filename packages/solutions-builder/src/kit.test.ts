import { describe, expect, test } from "bun:test";
import { agentById } from "./kit.js";
import { STACK_BLOCK_SHAPE } from "./stack.js";

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
