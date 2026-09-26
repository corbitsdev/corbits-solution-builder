import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

// #93: an action longer than half a second must say the app is busy somewhere
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

  test("the figure walks and rakes in step, the strip grows from nothing, and all of it stills under reduced motion", () => {
    const css = read("./styles.css");
    expect(css).toMatch(/\.zen-garden \{[^}]*height: 0;/s);
    expect(css).toContain(".zen-garden[data-visible] {");
    expect(css).toMatch(/\.zen-raked \{[^}]*animation: zen-rake 14s linear infinite;/s);
    expect(css).toMatch(/\.zen-raker \{[^}]*animation: zen-walk 14s linear infinite;/s);
    expect(css).toContain("100% { transform: translateX(calc(100vw - 56px)); opacity: 0; }");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".zen-raker,");
    expect(reduced).toContain(".zen-raked {\n    clip-path: none;\n  }");
  });
});
