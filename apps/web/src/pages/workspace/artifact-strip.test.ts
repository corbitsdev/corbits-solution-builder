import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactStrip, stripOverflow } from "./artifact-strip.tsx";
import type { ArtifactTab } from "./use-project-artifacts.ts";

describe("stripOverflow", () => {
  test("nothing hidden when the list fits", () => {
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 500, scrollWidth: 500 })).toEqual({ left: false, right: false });
  });
  test("tabs hidden past the right edge at the start, past the left once scrolled", () => {
    expect(stripOverflow({ scrollLeft: 0, clientWidth: 500, scrollWidth: 1400 })).toEqual({ left: false, right: true });
    expect(stripOverflow({ scrollLeft: 900, clientWidth: 500, scrollWidth: 1400 })).toEqual({ left: true, right: false });
    expect(stripOverflow({ scrollLeft: 300, clientWidth: 500, scrollWidth: 1400 })).toEqual({ left: true, right: true });
  });
});

describe("ArtifactStrip", () => {
  const tab = (key: string, label: string): ArtifactTab =>
    ({ key, label, kind: "document", stage: 1, variant: null, live: false, versions: [] }) as unknown as ArtifactTab;

  test("renders an edge control for each side, hidden until measurement finds tabs past that edge", () => {
    const html = renderToStaticMarkup(
      createElement(ArtifactStrip, { tabs: [tab("a", "Problem brief"), tab("b", "Design")], selectedKey: "b", onSelect: () => undefined }),
    );
    expect(html).toContain('aria-label="Show earlier artifacts"');
    expect(html).toContain('aria-label="Show more artifacts"');
    expect(html.match(/class="artifact-strip-scroll[^"]*" hidden=""/g)?.length).toBe(2);
    expect(html).toContain('aria-label="Project artifacts"');
  });
});
