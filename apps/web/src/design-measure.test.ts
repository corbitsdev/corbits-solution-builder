import { describe, expect, test } from "bun:test";
import { fitDesignScale } from "./design-measure.ts";

// #268: a design wider than the pane is scaled to fit; one that fits, or
// one nothing is known about, is shown as it is.
describe("fitDesignScale", () => {
  test("shrinks a wide design to the pane and leaves a narrow one alone", () => {
    expect(fitDesignScale(1600, 800)).toBe(0.5);
    expect(fitDesignScale(800, 800)).toBe(1);
    expect(fitDesignScale(600, 800)).toBe(1);
  });

  test("an unknown or nonsensical width means no scaling", () => {
    expect(fitDesignScale(null, 800)).toBe(1);
    expect(fitDesignScale(Number.NaN, 800)).toBe(1);
    expect(fitDesignScale(1600, 0)).toBe(1);
    expect(fitDesignScale(0, 800)).toBe(1);
  });
});
