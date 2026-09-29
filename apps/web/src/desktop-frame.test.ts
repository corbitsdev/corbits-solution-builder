import { describe, expect, test } from "bun:test";
import { DESKTOP_WINDOW, fitScale } from "./desktop-frame.tsx";

// #264: the window is drawn at its own size and scaled to the width it has.
describe("fitScale", () => {
  test("scales a 1280 window down to the pane and never up", () => {
    expect(fitScale(640, DESKTOP_WINDOW.width)).toBe(0.5);
    expect(fitScale(1280, DESKTOP_WINDOW.width)).toBe(1);
    expect(fitScale(2000, DESKTOP_WINDOW.width)).toBe(1);
  });

  test("an unmeasured box draws at full size until it is measured", () => {
    expect(fitScale(0, DESKTOP_WINDOW.width)).toBe(1);
    expect(fitScale(Number.NaN, DESKTOP_WINDOW.width)).toBe(1);
  });
});
