import { describe, expect, test } from "bun:test";
import { PHONE_SCREEN_RATIO, bodyFor, frameGeometry, frameLabel, frameMockup, framedMockupShots } from "./mockup-frames.ts";

// #654: the body around a screen is sized from the screen.
describe("frameGeometry", () => {
  test("a phone body is the phone's: its screen height follows the device, not the page (#670)", () => {
    const g = frameGeometry("phone", 804, 1740);
    const screenHeight = Math.round(804 * PHONE_SCREEN_RATIO);
    expect(g.screen).toEqual({ x: 38, y: 38, width: 804, height: screenHeight, radius: 88 });
    expect([g.width, g.height]).toEqual([804 + 76, screenHeight + 76]);
    expect(g.bodyRadius).toBe(88 + 38);
    // A page three times as long gets the same phone.
    expect(frameGeometry("phone", 804, 5200).height).toBe(g.height);
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

// #666: screens are framed at capture, so slides, preview, print and download all draw the body.
describe("framedMockupShots", () => {
  test("a framed shot is never framed again, and outside a browser there is nothing to capture", async () => {
    const png = Uint8Array.of(1);
    expect(await frameMockup({ name: "x", png, kind: "desktop", width: 1280, height: 960, framed: true })).toBe(png);
    expect(await framedMockupShots("<!doctype html><html><body><section data-surface=\"phone\">x</section></body></html>")).toEqual([]);
  });

  test("the slide builders capture through the framer", async () => {
    for (const file of ["./deck-save.ts", "./pages/audiences.tsx", "./documents-archive.ts"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).toContain("framedMockupShots");
      expect(source).not.toMatch(/[^d]mockupShots\(/);
    }
  });
});

// #668: a handset only around a portrait picture.
describe("bodyFor", () => {
  test("a landscape picture marked as a phone's gets the browser window; a portrait one keeps the handset", () => {
    expect(bodyFor("phone", 2560, 1920)).toBe("desktop");
    expect(bodyFor("phone", 804, 1740)).toBe("phone");
    expect(bodyFor("desktop", 804, 1740)).toBe("desktop");
  });

  test("the capture lays a phone screen out at phone width", async () => {
    const source = await Bun.file(new URL("./mockup-shots.ts", import.meta.url)).text();
    expect(source).toContain("export const PHONE_FRAME_WIDTH = 402;");
    expect(source).toMatch(/frame\.style\.width = kind === "phone" \? `\$\{String\(PHONE_FRAME_WIDTH\)\}px`/);
  });
});
