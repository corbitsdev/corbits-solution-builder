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
    expect(app).toContain('useBusyWhile(view === "project" && detail === null && detailError === null, "Opening the project");');
    expect(app).toContain('useBusyWhile(exporting, "Building the document package");');
    const css = read("./styles.css");
    expect(css).toMatch(/\.app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
  });

  test("a loading button counts as busy and says what it is doing, so every action that spins also rakes and is named", () => {
    const components = read("./components.tsx");
    // #223: the control's own words, or what it was told it is doing.
    expect(components).toContain("const busyLabel = doing ?? controlText(children) ?? undefined;");
    expect(components).toContain("if (!loading) return;\n    return beginBusy(busyLabel);");
    const audiences = read("./pages/audiences.tsx");
    expect(audiences).toContain("useBusyWhile(writingNames.length > 0,");
    expect(audiences).toContain("doing={packageWork(selected.variant)}");
  });

  test("the workspace counts a specialist turn in flight and a thread still loading", () => {
    const index = read("./pages/workspace/index.tsx");
    expect(index).toContain("useBusyWhile(busy, specialistActivity(stage, pendingAsk));");
    expect(index).toContain('useBusyWhile(!threadLoaded, "Opening the conversation");');
  });

  test("the garden names its state, keeps the clock out of the live region, and is hidden from readers as decoration", () => {
    const garden = read("./zen-garden.tsx");
    // The film is decoration; the strip itself holds the grip, which readers do reach (#120).
    expect(garden).toContain('<div className="zen-garden-strip">');
    expect(garden).toMatch(/<video[\s\S]*?aria-hidden="true"/);
    expect(garden).toContain('<span role="status" aria-live="polite">');
    expect(garden).toContain('<span className="zen-garden-clock" role="timer" aria-live="off">');
    expect(garden).toContain('data-visible={visible ? "" : undefined}');
    // #113: what the work is, under the clock, in a live region of its own.
    expect(garden).toContain('<p className="zen-garden-doing" role="status" aria-live="polite">');
    expect(garden).toContain("{visible && label ? label : null}");
    expect(read("./pages/workspace/index.tsx")).toContain("useBusyWhile(busy, specialistActivity(stage, pendingAsk));");
  });

  // #120: a grip along the top edge sets the height by drag or keyboard,
  // and the chosen height is applied as the strip's own variable.
  test("the strip's top edge is a resize grip, and a chosen height overrides the default", () => {
    const garden = read("./zen-garden.tsx");
    expect(garden).toContain('className="zen-garden-grip"');
    expect(garden).toContain('role="separator"');
    expect(garden).toContain("onPointerDown={size.onPointerDown}");
    expect(garden).toContain("onKeyDown={size.onKeyDown}");
    expect(garden).toContain('style={size.height !== null ? ({ "--zen-height": `${size.height}px` } as CSSProperties) : undefined}');
    const css = read("./styles.css");
    expect(css).toMatch(/\.zen-garden-grip \{[^}]*cursor: ns-resize;/s);
    expect(css).toMatch(/\.zen-garden\[data-resizing\] \{[^}]*transition: none;/s);
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
    // #111: the film edge to edge across the strip, cropped to its height.
    expect(css).toMatch(/\.zen-garden-video \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: cover;/s);
    expect(css).toMatch(/\.zen-garden-strip \{[^}]*justify-content: center;/s);
    expect(css).toContain('background: url("/zen-garden-bg.jpg") center / auto 100% repeat-x');
    expect(css).toMatch(/\.zen-garden \{[^}]*--zen-height: clamp\(70px, 11vh, 120px\);/s);
    expect(existsSync(join(here, "../public/zen-garden-bg.jpg"))).toBe(true);
    expect(css).not.toContain("zen-raker");
  });
});
