import { describe, expect, test } from "bun:test";
import { agentById } from "./kit.js";

describe("Experience designer prompt", () => {
  test("asks every desktop or phone screen to fit both review widths (#417)", () => {
    const prompt = agentById("experience-designer")!.system;
    expect(prompt).toContain("Every desktop or phone screen lays out at both widths.");
    expect(prompt).toContain("1280px and at 402px");
    expect(prompt).toContain("@media (max-width: 640px)");
    expect(prompt).toContain("minmax(0, 1fr)");
    expect(prompt).toContain("scrolls inside its own panel");
  });
});
