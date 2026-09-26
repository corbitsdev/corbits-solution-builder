import { describe, expect, test } from "bun:test";
import { agentById } from "./kit.js";

describe("Experience designer prompt", () => {
  test("requires the mockup to fit the width it is read at, not a wide monitor", () => {
    const designer = agentById("experience-designer");
    expect(designer).toBeDefined();
    const prompt = designer!.system;
    expect(prompt).toContain("The mockup fits the width it is read at.");
    expect(prompt).toContain("any width from 1024px up");
    expect(prompt).toContain("minmax(0, 1fr)");
    expect(prompt).toContain("nothing clipped at the right edge");
    expect(prompt).toContain("scrolls inside its own panel");
  });
});

// #101: a phone screen is the screen only; the review window draws the phone.
describe("Experience designer phone screens", () => {
  test("marks each phone screen and draws no device around it", () => {
    const prompt = agentById("experience-designer")!.system;
    expect(prompt).toContain("A phone screen is drawn as the screen, never as the phone.");
    expect(prompt).toContain('<section data-testid="screen-<name>" data-surface="phone">');
    expect(prompt).toContain("402px-wide viewport");
    expect(prompt).toContain("no bezel, notch or rounded device");
    expect(prompt).not.toContain("a phone-width frame\n  with a notch");
  });
});
