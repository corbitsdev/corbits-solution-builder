import { describe, expect, test } from "bun:test";
import { frameGeometry, frameLabel, frameMockup } from "./mockup-frames.ts";

// #654: the body around a screen is sized from the screen.
describe("frameGeometry", () => {
  test("a phone body wraps the screen in an even bezel with rounded corners", () => {
    const g = frameGeometry("phone", 804, 1740);
    expect(g.screen).toEqual({ x: 38, y: 38, width: 804, height: 1740, radius: 88 });
    expect([g.width, g.height]).toEqual([804 + 76, 1740 + 76]);
    expect(g.bodyRadius).toBe(88 + 38);
  });

  test("a browser window puts a title bar above the page and a hairline round it", () => {
    const g = frameGeometry("desktop", 2560, 1920);
    expect(g.screen.y).toBeGreaterThanOrEqual(44);
    expect(g.screen).toMatchObject({ x: 2, width: 2560, height: 1920, radius: 0 });
    expect(g.width).toBe(2564);
    expect(g.height).toBe(1920 + g.screen.y + 2);
  });

  test("labels say which body a picture was drawn in", () => {
    expect(frameLabel("phone")).toBe("in a phone body");
    expect(frameLabel("desktop")).toBe("in a browser window");
    expect(frameLabel(undefined)).toBe("as captured");
  });

  test("outside a browser, or with no kind, the picture is returned as it is", async () => {
    const png = Uint8Array.of(1, 2, 3);
    expect(await frameMockup({ name: "x", png })).toBe(png);
    expect(await frameMockup({ name: "x", png, kind: "phone", width: 402, height: 800 })).toBe(png);
  });
});
