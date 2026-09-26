import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

// #87: while a specialist turn is in flight the inference row's flame burns
// and the conversation column breathes; both are driven by the one pending
// turn the workspace already tracks, and both go still under reduced motion.
describe("inference activity", () => {
  test("the inference row carries the pending state and a flame that names it", () => {
    const index = read("./index.tsx");
    expect(index).toContain('<div className="stage-model-row" data-inference-pending={pending !== null ? "" : undefined}>');
    expect(index).toContain('aria-label={pending !== null ? "Inference running" : "Inference idle"}');
  });

  test("every pane layout passes the pending state on, and the conversation column carries it", () => {
    const index = read("./index.tsx");
    const panes = index.match(/<StagePanes\b[^>]*>/gs) ?? [];
    expect(panes.length).toBeGreaterThan(0);
    for (const usage of panes) expect(usage).toContain("busy={pending !== null}");
    expect(read("./workspace-chrome.tsx")).toContain('data-inference-pending={busy ? "" : undefined}');
  });

  test("the flame and the breathing border are styled, and stilled under reduced motion", () => {
    const css = read("../../styles.css");
    expect(css).toContain(".stage-model-row[data-inference-pending] .inference-flame {");
    expect(css).toContain(".conv[data-inference-pending] {");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".conv[data-inference-pending] { animation: none; }");
  });
});
