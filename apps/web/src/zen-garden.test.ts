import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

// #93: an action longer than one second must say the app is busy somewhere
// the eye can find it — the garden along the foot of the window — not only
// inside the button that was pressed.
describe("the zen garden busy indicator", () => {
  test("the shell mounts the garden as its third row, and registers its own waits", () => {
    const app = read("./app.tsx");
    expect(app).toContain("<ZenGarden />");
    expect(app).toContain('useBusyWhile(view === "project" && detail === null && detailError === null);');
    expect(app).toContain("useBusyWhile(exporting);");
    const css = read("./styles.css");
    expect(css).toMatch(/\.app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
  });

  test("a loading button counts as busy, so every action that spins also rakes", () => {
    const components = read("./components.tsx");
    expect(components).toContain("if (!loading) return;\n    return beginBusy();");
  });

  test("the workspace counts a specialist turn in flight and a thread still loading", () => {
    const index = read("./pages/workspace/index.tsx");
    expect(index).toContain("useBusyWhile(pending !== null);");
    expect(index).toContain("useBusyWhile(!threadLoaded);");
  });

  test("the garden names its state, keeps the clock out of the live region, and is hidden from readers as decoration", () => {
    const garden = read("./zen-garden.tsx");
    expect(garden).toContain('<div className="zen-garden-strip" aria-hidden="true">');
    expect(garden).toContain('<span role="status" aria-live="polite">');
    expect(garden).toContain('<span className="zen-garden-clock" role="timer" aria-live="off">');
    expect(garden).toContain('data-visible={visible ? "" : undefined}');
  });

  // #107: the film, looped and silent, mounted only while the strip is up,
  // and held on its first frame under reduced motion.
  test("the film loops silently while the strip is up, and holds still under reduced motion", () => {
    const garden = read("./zen-garden.tsx");
    expect(garden).toContain("{visible ? <GardenFilm still={still} /> : null}");
    expect(garden).toContain("autoPlay={!still}");
    expect(garden).toMatch(/<video[\s\S]*?\bloop\b[\s\S]*?\bmuted\b[\s\S]*?\bplaysInline\b/);
    expect(garden).toContain("element.muted = true;");
    expect(garden).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(existsSync(join(here, "../public/zen-garden.mp4"))).toBe(true);
    expect(existsSync(join(here, "../public/zen-garden-poster.jpg"))).toBe(true);
    const css = read("./styles.css");
    expect(css).toMatch(/\.zen-garden \{[^}]*height: 0;/s);
    expect(css).toContain(".zen-garden[data-visible] {");
    // #109: the whole film, fitted to the strip's height and centred, over tiled sand.
    expect(css).toMatch(/\.zen-garden-video \{[^}]*height: 100%;[^}]*width: auto;[^}]*object-fit: contain;/s);
    expect(css).toMatch(/\.zen-garden-strip \{[^}]*justify-content: center;/s);
    expect(css).toContain('background: url("/zen-garden-bg.jpg") center / auto 100% repeat-x');
    expect(css).toMatch(/\.zen-garden \{[^}]*--zen-height: clamp\(70px, 11vh, 120px\);/s);
    expect(existsSync(join(here, "../public/zen-garden-bg.jpg"))).toBe(true);
    expect(css).not.toContain("zen-raker");
  });
});
