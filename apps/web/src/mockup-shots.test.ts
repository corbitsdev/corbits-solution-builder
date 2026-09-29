import { describe, expect, test } from "bun:test";
import { mockupShots, placeMockups, shotSvg } from "./mockup-shots.ts";

const a = Uint8Array.of(1);
const b = Uint8Array.of(2);
const c = Uint8Array.of(3);
const deck = (count: number, images?: Map<string, Uint8Array>) => ({
  slides: Array.from({ length: count }, (_, index) => ({ title: `Slide ${String(index + 1)}`, bullets: [], notes: "" })),
  ...(images ? { images } : {}),
});

describe("placeMockups", () => {
  test("the cover takes the first screen and each item slide the next, cycling", () => {
    const placed = placeMockups(deck(4), [a, b, c]);
    expect(placed.get("cover")).toBe(a);
    expect(placed.get("0")).toBe(b);
    expect(placed.get("1")).toBe(c);
    expect(placed.get("2")).toBe(a);
    expect(placed.get("3")).toBe(b);
  });

  test("an illustration already drawn is kept, and the screens go to the slides without one", () => {
    const drawn = Uint8Array.of(9);
    const placed = placeMockups(deck(2, new Map([["cover", drawn], ["1", drawn]])), [a, b]);
    expect(placed.get("cover")).toBe(drawn);
    expect(placed.get("0")).toBe(a);
    expect(placed.get("1")).toBe(drawn);
  });

  test("no screens leaves the pictures as they were", () => {
    const drawn = new Map([["cover", a]]);
    const placed = placeMockups(deck(2, drawn), []);
    expect([...placed.entries()]).toEqual([["cover", a]]);
    expect(placed).not.toBe(drawn);
  });
});

// #230: the host allows images from 'self' and data: only, and a computed
// font carries quotes that would end a style attribute early.
describe("shotSvg", () => {
  test("is a data: URL whose wrapper look lives in a style rule with the CSS escaped as XML text", () => {
    const url = shotSvg('<section xmlns="http://www.w3.org/1999/xhtml">x</section>', "a>b{color:red} .q::before{content:\"<\"}", { width: 402.4, height: 600 }, {
      backgroundColor: "rgb(244, 245, 247)",
      color: "rgb(22, 24, 29)",
      font: '15px / 1.45 -apple-system, "Segoe UI", sans-serif',
    });
    expect(url).toStartWith("data:image/svg+xml;charset=utf-8,");
    const svg = decodeURIComponent(url.slice("data:image/svg+xml;charset=utf-8,".length));
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="403" height="600">');
    expect(svg).toContain('<div xmlns="http://www.w3.org/1999/xhtml" class="sb-shot">');
    expect(svg).toContain('.sb-shot{width:403px;height:600px;overflow:hidden;background:rgb(244, 245, 247);color:rgb(22, 24, 29);font:15px / 1.45 -apple-system, "Segoe UI", sans-serif}');
    expect(svg).toContain("a&gt;b{color:red}".replace("&gt;", ">"));
    expect(svg).toContain('.q::before{content:"&lt;"}');
    expect(svg).not.toMatch(/style="[^"]*font:/);
    expect(svg).toContain('<section xmlns="http://www.w3.org/1999/xhtml">x</section>');
  });
});

describe("mockupShots", () => {
  test("draws nothing outside a browser", async () => {
    expect(await mockupShots("<!doctype html><html><body><section data-surface=\"phone\">x</section></body></html>")).toEqual([]);
  });
});
