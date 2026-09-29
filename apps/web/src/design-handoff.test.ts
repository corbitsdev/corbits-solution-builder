import { describe, expect, test } from "bun:test";
import { DESIGN_TEXT_CAP, designAsText, designHandoff } from "./design-handoff.ts";

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
    expect(text).toEndWith("[… the design's text continues; the full mockup is the stage 4 artifact]");
  });
});

describe("designHandoff", () => {
  test("hands an HTML design over as its text in a labelled block, never as markup", () => {
    const handoff = designHandoff(MOCKUP);
    expect(handoff).toStartWith("The approved design is an HTML mockup, on record as the stage 4 artifact. Its text, for reference:\n\n```text\n# Mockup — phone companion");
    expect(handoff).toEndWith("\n```");
    expect(handoff).not.toContain("<section");
    expect(handoff).not.toContain("<!doctype");
  });

  test("passes a Markdown design through untouched", () => {
    const markdown = "## Design\n\nA phone app with three tabs.";
    expect(designHandoff(markdown)).toBe(markdown);
  });
});
