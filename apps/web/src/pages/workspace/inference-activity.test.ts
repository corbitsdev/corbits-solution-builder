import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

// #87: while a specialist turn is in flight the inference row's flame burns,
// driven by the one pending turn the workspace already tracks, and goes still
// under reduced motion.
describe("inference activity", () => {
  test("the inference row carries the pending state and a flame that names it", () => {
    const index = read("./index.tsx");
    expect(index).toContain('<div className="stage-model-row" data-inference-pending={busy ? "" : undefined}>');
    expect(index).toContain('aria-label={busy ? "Inference running" : "Inference idle"}');
  });

  test("every pane layout passes the pending state on, and the conversation column carries it", () => {
    const index = read("./index.tsx");
    const panes = index.match(/<StagePanes\b[^>]*>/gs) ?? [];
    expect(panes.length).toBeGreaterThan(0);
    for (const usage of panes) expect(usage).toContain("busy={busy}");
    expect(read("./workspace-chrome.tsx")).toContain('data-inference-pending={busy ? "" : undefined}');
  });

  test("the flame is styled, and stilled under reduced motion", () => {
    const css = read("../../styles.css");
    expect(css).toContain(".stage-model-row[data-inference-pending] .inference-flame {");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".stage-model-row[data-inference-pending] .inference-flame { animation: none; }");
  });
});
