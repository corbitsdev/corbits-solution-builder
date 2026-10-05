import { beforeEach, describe, expect, test } from "bun:test";
import { cachedFramedMockupShots, designKey, forgetDrawnScreens } from "./mockup-cache.ts";
import type { MockupShot } from "./mockup-shots.ts";

describe("cachedFramedMockupShots", () => {
  beforeEach(() => forgetDrawnScreens());

  test("draws a design once and shares the drawing; a different design or count draws again", async () => {
    let draws = 0;
    const draw = async (): Promise<MockupShot[]> => {
      draws += 1;
      return [{ name: "home", png: new Uint8Array([draws]) }];
    };
    const a = cachedFramedMockupShots("<html>a</html>", 12, draw);
    const b = cachedFramedMockupShots("<html>a</html>", 12, draw);
    expect(b).toBe(a);
    expect((await a)[0]!.png[0]).toBe(1);
    await cachedFramedMockupShots("<html>a</html>", 12, draw);
    expect(draws).toBe(1);
    await cachedFramedMockupShots("<html>b</html>", 12, draw);
    await cachedFramedMockupShots("<html>a</html>", 8, draw);
    expect(draws).toBe(3);
  });

  test("a drawing that fails is not kept", async () => {
    let draws = 0;
    const draw = async (): Promise<MockupShot[]> => {
      draws += 1;
      if (draws === 1) throw new Error("no browser");
      return [];
    };
    await expect(cachedFramedMockupShots("<html>x</html>", 12, draw)).rejects.toThrow("no browser");
    expect(await cachedFramedMockupShots("<html>x</html>", 12, draw)).toEqual([]);
    expect(draws).toBe(2);
  });

  test("the key tells designs apart and is stable", () => {
    expect(designKey("<html>a</html>", 12)).toBe(designKey("<html>a</html>", 12));
    expect(designKey("<html>a</html>", 12)).not.toBe(designKey("<html>b</html>", 12));
    expect(designKey("<html>a</html>", 12)).not.toBe(designKey("<html>a</html>", 8));
  });
});
