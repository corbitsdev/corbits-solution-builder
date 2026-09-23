import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorLabel, looksLikeHtmlDocument } from "./design.tsx";

const here = import.meta.dir;

function read(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

describe("stage 4 design pane", () => {
  const page = read("./design.tsx");
  const css = read("../styles.css");

  test("the mockup is a stage-inner document, not a second app chrome", () => {
    expect(page).toContain('className="stage-inner"');
    expect(page).toContain('className="doc" data-tour="design-feedback"');
    expect(page).toContain('className="docmeta"');
    expect(page).not.toContain("<Screen");
    expect(page).not.toContain("EmptyState");
    expect(page).not.toContain("stage-gate");
    expect(page).not.toContain("Happy with version");
    expect(page).not.toContain('title="Design feedback"');
    expect(page).not.toContain('title="Anchored comments"');
    expect(page).not.toContain("Reviewing ");
    expect(page).not.toContain('className="bento"');
    expect(page).not.toContain("design-reviewing");
  });

  test("iframe preview, approve, and comment stay", () => {
    expect(page).toContain("srcDoc={content}");
    expect(page).toContain('sandbox=""');
    expect(page).toContain('className="design-preview"');
    expect(page).toContain("Approve and continue");
    expect(page).toContain("Send for approval");
    expect(page).toContain("Add this comment");
    expect(page).toContain("Submit feedback and generate the next version");
    expect(page).toContain('data-tour="design-submit"');
    expect(page).toContain("setDesignFeedbackDisposition");
  });

  test("a non-HTML reply renders as markdown instead of an empty preview frame", () => {
    expect(page).toContain("looksLikeHtmlDocument(content)");
    expect(page).toContain("<Markdown source={content} />");
  });

  test("design-review is not a padded chrome dump", () => {
    expect(css).toContain(".design-preview {");
    const review = css.slice(css.indexOf(".design-review {"), css.indexOf(".design-review .doc {"));
    expect(review).toContain("min-height: 0");
    expect(review).not.toContain("overflow-y: auto");
    expect(review).not.toContain("padding:");
  });
});

describe("anchorLabel", () => {
  test("prefers a stable test id over a DOM path", () => {
    expect(anchorLabel({ testId: "hero", domPath: "div:nth-child(1)" })).toBe("#hero");
  });
});

describe("looksLikeHtmlDocument", () => {
  test("a compliant self-contained mockup is HTML", () => {
    expect(looksLikeHtmlDocument("<!doctype html>\n<html><body>hi</body></html>")).toBe(true);
    expect(looksLikeHtmlDocument("  <html>\n<body>hi</body></html>")).toBe(true);
  });

  test("a qwen-shaped markdown reply — the kit asked for HTML only — is not", () => {
    const reply = [
      "## Chosen approach: Centralized Booking System",
      "",
      "The chosen approach is a centralized booking system that provides a",
      "streamlined experience for customers to book appointments and ensures",
      "stylists receive accurate notifications.",
      "",
      "## Approach A: Centralized Booking System",
      "### How it works",
      "- A centralized web application allows customers to book appointments.",
    ].join("\n");
    expect(looksLikeHtmlDocument(reply)).toBe(false);
  });
});
