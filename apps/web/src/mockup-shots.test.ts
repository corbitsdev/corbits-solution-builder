import { describe, expect, test } from "bun:test";
import { captureHeight, chooseScreens, mockupShots, placeMockups, screenKind, screenNamesOf, shotSvg, type MockupShot } from "./mockup-shots.ts";

const a = Uint8Array.of(1);
const b = Uint8Array.of(2);
const c = Uint8Array.of(3);
/** Screens named for their picture: `a` is "alpha", `b` "beta", `c` "gamma". */
const NAMES = new Map<Uint8Array, string>([
  [a, "alpha"],
  [b, "beta"],
  [c, "gamma"],
]);
const S = (...pngs: Uint8Array[]): MockupShot[] => pngs.map((png) => ({ name: NAMES.get(png) ?? "screen", png }));
const deck = (count: number, images?: Map<string, Uint8Array>) => ({
  slides: Array.from({ length: count }, (_, index) => ({ title: `Slide ${String(index + 1)}`, bullets: ["A line."], notes: "" })),
  ...(images ? { images } : {}),
});

describe("placeMockups", () => {
  // #252: pictures are optional, no two slides in a row show the same
  // screen, and a slide with no lines is its picture.
  test("the cover takes a screen and the rest are spread over the item slides, each used once", () => {
    const placed = placeMockups(deck(4), S(a, b, c));
    expect(placed.get("cover")).toBe(a);
    // Two screens over four slides land on the second and the fourth: apart, not both up front.
    expect(placed.get("0")).toBeUndefined();
    expect(placed.get("1")).toBe(b);
    expect(placed.get("2")).toBeUndefined();
    expect(placed.get("3")).toBe(c);
  });

  test("screens are never repeated: with more slides than screens the rest stay bare", () => {
    const placed = placeMockups(deck(6), S(a, b));
    expect(placed.get("cover")).toBe(a);
    const pictured = [...placed.entries()].filter(([key]) => key !== "cover");
    expect(pictured).toEqual([["3", b]]);
  });

  test("with as many screens as slides every item slide gets its own, in order", () => {
    const placed = placeMockups(deck(2), S(a, b, c));
    expect(placed.get("cover")).toBe(a);
    expect(placed.get("0")).toBe(b);
    expect(placed.get("1")).toBe(c);
  });

  test("a slide with no lines is its picture and takes a screen before the cover does", () => {
    const slides = [
      { title: "The problem", bullets: ["Costs rise."], notes: "" },
      { title: "What it looks like", bullets: [], notes: "" },
      { title: "The plan", bullets: ["Ship it."], notes: "" },
    ];
    const placed = placeMockups({ slides }, S(a, b));
    expect(placed.get("1")).toBe(a);
    expect(placed.get("cover")).toBe(b);
    expect(placed.get("0")).toBeUndefined();
    expect(placed.get("2")).toBeUndefined();
  });

  test("an illustration already drawn is kept, and the screens go to the slides without one", () => {
    const drawn = Uint8Array.of(9);
    const placed = placeMockups(deck(2, new Map([["cover", drawn], ["1", drawn]])), S(a, b));
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

// #302: a slide that names a screen takes it, and the rest are placed as before.
describe("placeMockups with named screens", () => {
  test("a named screen goes to its slide, by name or by number, and is not handed out again", () => {
    const slides = [
      { title: "What it looks like", bullets: [], notes: "", screen: "gamma" },
      { title: "Timeline", bullets: ["Days."], notes: "", screen: "1" },
      { title: "Cost", bullets: ["Rough."], notes: "" },
    ];
    const placed = placeMockups({ slides }, S(a, b, c));
    expect(placed.get("0")).toBe(c);
    expect(placed.get("1")).toBe(a);
    expect(placed.get("cover")).toBe(b);
    expect(placed.get("2")).toBeUndefined();
  });

  test("a name the design does not have is ignored and the slide is placed as any other", () => {
    const slides = [{ title: "What it looks like", bullets: [], notes: "", screen: "nowhere" }];
    const placed = placeMockups({ slides }, S(a, b));
    expect(placed.get("0")).toBe(a);
    expect(placed.get("cover")).toBe(b);
  });
});

describe("screenNamesOf and captureHeight", () => {
  test("lists the screen and view test ids as words, once each in order; surface kinds only when no screen is named", () => {
    expect(screenNamesOf('<section data-testid="screen-phone-home" data-surface="phone"></section><section data-testid="view-gantt" data-surface="desktop"></section><section data-testid="design-notes"></section>')).toEqual(["phone home", "gantt"]);
    expect(screenNamesOf('<section data-surface="phone"></section><div data-surface=\'web\'></div><section data-surface="phone"></section>')).toEqual(["phone", "web"]);
    expect(screenNamesOf("<body><p>no screens</p></body>")).toEqual([]);
  });

  test("a wide page is captured as a viewport of its top; a phone screen whole", () => {
    expect(captureHeight(1280, 2400)).toBe(960);
    expect(captureHeight(1280, 700)).toBe(700);
    expect(captureHeight(402, 900)).toBe(900);
  });
});

describe("mockupShots", () => {
  test("draws nothing outside a browser", async () => {
    expect(await mockupShots("<!doctype html><html><body><section data-surface=\"phone\">x</section></body></html>")).toEqual([]);
  });
});

// #284: a design with no surface marks is shot screen by screen, never as
// one tall page.
describe("chooseScreens", () => {
  test("marked surfaces win, then named screens, then top-level sections, and the body only last", () => {
    expect(chooseScreens({ surfaces: ["s1"], named: ["n1"], sections: ["t1"], body: "body" })).toEqual(["s1"]);
    expect(chooseScreens({ surfaces: [], named: ["n1", "n2"], sections: ["t1"], body: "body" })).toEqual(["n1", "n2"]);
    expect(chooseScreens({ surfaces: [], named: [], sections: ["t1", "t2"], body: "body" })).toEqual(["t1", "t2"]);
    expect(chooseScreens({ surfaces: [], named: [], sections: [], body: "body" })).toEqual(["body"]);
  });
});

// #654: a screen's kind decides the body it is drawn in.
describe("screenKind", () => {
  test("the surface mark wins, then a telling test id, then the width", () => {
    expect(screenKind("phone", null, 1280)).toBe("phone");
    expect(screenKind("desktop", "screen-phone-home", 400)).toBe("desktop");
    expect(screenKind(null, "view-mobile-checkout", 1280)).toBe("phone");
    expect(screenKind(null, "view-gantt-loading", 1280)).toBe("desktop");
    expect(screenKind(null, "view-home", 402)).toBe("phone");
    expect(screenKind(undefined, undefined, 900)).toBe("desktop");
  });
});
