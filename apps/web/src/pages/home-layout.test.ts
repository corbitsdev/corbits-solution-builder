import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "home-layout.css"), "utf8");

/** Every selector in the stylesheet, one per rule, prelude only. */
function selectors(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)].map((match) => match[2]!.trim());
}

/** Tailwind utility class names the `@corbits/react-ui` components carry on
 *  their own elements. The home stylesheet styling one of them by name
 *  restyles those components too: `.home-page .grid` once gave the
 *  composer's 30 px send button a 320 px grid column, which put its icon
 *  outside the button. */
const UTILITY_CLASSES = ["grid", "flex", "size-9", "size-4", "rounded-md", "shrink-0", "place-items-center"];

describe("home-layout.css", () => {
  test("styles the project card list under its own class", () => {
    expect(selectors(css)).toContain(".home-page .project-grid");
  });

  test("never targets a utility class name the library's components carry", () => {
    const offending = selectors(css).filter((selector) =>
      UTILITY_CLASSES.some((name) => new RegExp(`(^|[\\s>+~])\\.${name.replace(/[-.]/g, "\\$&")}(?![\\w-])`).test(selector)),
    );
    expect(offending).toEqual([]);
  });
});
