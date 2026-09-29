import { describe, expect, test } from "bun:test";
import { lookFromPixels } from "./pdf-look.ts";

/** A page of `pixels` colours, each an [r, g, b, count] run. */
function page(runs: readonly (readonly [number, number, number, number])[]): Uint8ClampedArray {
  const total = runs.reduce((sum, run) => sum + run[3], 0);
  const out = new Uint8ClampedArray(total * 4);
  let at = 0;
  for (const [r, g, b, count] of runs) {
    for (let i = 0; i < count; i += 1) {
      out.set([r, g, b, 255], at);
      at += 4;
    }
  }
  return out;
}

// #254: a PDF of a deck lends its paper, ink, accent and ratio; never a typeface.
describe("lookFromPixels", () => {
  test("finds the paper, the ink and the accent by how much of the page each covers", () => {
    const look = lookFromPixels([page([[250, 250, 250, 8000], [30, 32, 40, 1500], [30, 58, 138, 300], [200, 30, 30, 20]])], 16 / 9)!;
    // Colours come back as the centre of their 16-step bucket.
    expect(look.paper).toBe("F8F8F8");
    expect(look.ink).toBe("182828");
    expect(look.accent).toBe("183888");
    expect(look.ratio).toBe(1.78);
    expect(look.titleFace).toBeUndefined();
    expect(look.bodyFace).toBeUndefined();
  });

  test("a rare splash of colour is not the accent; a common one is", () => {
    const rare = lookFromPixels([page([[255, 255, 255, 10000], [20, 20, 20, 500], [200, 30, 30, 10]])], null)!;
    expect(rare.accent).toBeUndefined();
    const common = lookFromPixels([page([[255, 255, 255, 10000], [20, 20, 20, 500], [200, 30, 30, 300]])], null)!;
    expect(common.accent).toMatch(/^C8.*$/);
  });

  test("a dark deck reads its dark paper as ink and its light text as nothing paper-like unless it covers enough", () => {
    const look = lookFromPixels([page([[20, 20, 24, 9000], [240, 240, 240, 800], [255, 120, 0, 400]])], 4 / 3)!;
    expect(look.ink).toMatch(/^1/);
    expect(look.paper).toBe("F8F8F8");
    expect(look.accent).toMatch(/^F8/);
    expect(look.ratio).toBe(1.33);
  });

  test("transparent pixels are not counted, and nothing at all is not a theme", () => {
    const clear = new Uint8ClampedArray([255, 255, 255, 0, 0, 0, 0, 0]);
    expect(lookFromPixels([clear], null)).toBeNull();
    expect(lookFromPixels([], null)).toBeNull();
    expect(lookFromPixels([], 1.78)).toEqual({ ratio: 1.78 });
  });

  test("pages are counted together, so a photographic cover does not decide alone", () => {
    const cover = page([[90, 140, 60, 5000]]);
    const body = page([[255, 255, 255, 6000], [10, 10, 10, 600], [30, 58, 138, 400]]);
    const look = lookFromPixels([cover, body], null)!;
    expect(look.paper).toBe("F8F8F8");
    expect(look.accent).toMatch(/^58/);
  });
});
