import { describe, expect, test } from "bun:test";
import { mockupShots, placeMockups } from "./mockup-shots.ts";

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

describe("mockupShots", () => {
  test("draws nothing outside a browser", async () => {
    expect(await mockupShots("<!doctype html><html><body><section data-surface=\"phone\">x</section></body></html>")).toEqual([]);
  });
});
