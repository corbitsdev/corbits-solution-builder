import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TargetPicker } from "./freeze.tsx";

function render(chosen: string | null): string {
  return renderToStaticMarkup(createElement(TargetPicker, { chosen, onChange: () => undefined }));
}

describe("TargetPicker", () => {
  test("asks the question, with every target as an option, while nothing is chosen", () => {
    const html = render(null);
    expect(html).toContain("How will this be used?");
    expect(html).toContain('type="radio"');
    expect(html).not.toContain(">Change<");
  });

  test("once a target is chosen it states the target and offers to change it, instead of asking again", () => {
    const html = render("web");
    expect(html).toContain("Target:");
    expect(html).toContain("A website");
    expect(html).toContain(">Change<");
    expect(html).not.toContain("How will this be used?");
    expect(html).not.toContain('type="radio"');
  });
});
