import { describe, expect, test } from "bun:test";
import { agentById } from "./kit.js";

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
