import { describe, expect, test } from "bun:test";
import { DESIGN_TEXT_CAP, HANDOFF_LEAD, designAsText, designHandoff, splitHandoff } from "./design-handoff.ts";

const MOCKUP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mockup — phone companion</title>
<style>:root{--bg:#f4f5f7} body{margin:0}</style></head>
<body>
<!-- chrome -->
<section data-surface="phone"><h2>Phone screens</h2>
<p>Use the app&#39;s own navbar &amp; a three-tab bar.</p>
<ul><li>Destructive actions confirm in a dialog.</li><li>Keyboard focus is visible on every <code>button</code>.</li></ul>
<table><tr><th>Id</th><th>State</th></tr><tr><td>web-device-revoke-2</td><td>disabled</td></tr></table>
</section>
<script>document.title = "never";</script>
</body></html>`;

describe("designAsText", () => {
  test("keeps the title, headings, copy, lists and cells; drops styles, scripts, comments and tags", () => {
    const text = designAsText(MOCKUP);
    expect(text).toStartWith("# Mockup — phone companion\n\n## Phone screens\n\nUse the app's own navbar & a three-tab bar.");
    expect(text).toContain("- Destructive actions confirm in a dialog.");
    expect(text).toContain("- Keyboard focus is visible on every button .");
    expect(text).toContain("| Id | State");
    expect(text).toContain("| web-device-revoke-2 | disabled");
    expect(text).not.toMatch(/<[a-z!/]/i);
    expect(text).not.toContain("--bg");
    expect(text).not.toContain("never");
    expect(text).not.toContain("chrome");
  });

  test("caps a long design and says the rest is on record", () => {
    const long = `<!doctype html><html><body><p>${"copy ".repeat(4_000)}</p></body></html>`;
    const text = designAsText(long);
    expect(text.length).toBeLessThan(DESIGN_TEXT_CAP + 120);
    expect(text).toEndWith("[… the design's text continues; the full mockup is the GUI design artifact]");
  });
});

describe("designHandoff", () => {
  test("hands an HTML design over as its text in a labelled block, never as markup", () => {
    const handoff = designHandoff(MOCKUP);
    expect(handoff).toStartWith("The approved design is an HTML mockup, on record as the GUI design artifact. Its text, for reference:\n\nIts screens, which a slide may name as (screen: <name>): phone.\n\n```text\n# Mockup — phone companion");
    expect(handoff).toEndWith("\n```");
    expect(handoff).not.toContain("<section");
    expect(handoff).not.toContain("<!doctype");
  });

  // #301: the transcript shows the ask and folds the design.
  test("a message carrying a hand-off splits into its ask and the design's text; any other message does not", () => {
    const body = `Write the package for: You, the project owner.\n\nThe approved GUI design this package is built on, for reference:\n\n${designHandoff(MOCKUP)}`;
    const split = splitHandoff(body);
    expect(split?.lead).toBe("Write the package for: You, the project owner.\n\nThe approved GUI design this package is built on, for reference:");
    expect(split?.attached.startsWith(HANDOFF_LEAD)).toBe(true);
    expect(split?.attached).toContain("```text");
    expect(splitHandoff("Write the package for: You, the project owner.")).toBeNull();
  });

  test("passes a Markdown design through untouched", () => {
    const markdown = "## Design\n\nA phone app with three tabs.";
    expect(designHandoff(markdown)).toBe(markdown);
  });
});
