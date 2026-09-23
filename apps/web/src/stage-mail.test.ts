import { describe, expect, test } from "bun:test";
import { unescapeLiteralNewlines } from "./stage-mail.ts";

describe("unescapeLiteralNewlines", () => {
  test("a qwen-shaped reply with literal \\n instead of newlines is undone", () => {
    const reply =
      "## What I need from you\\n- Are appointments shared across multiple salons or restricted to a single location?\\n- What kind of notifications do you want for stylists (e.g., SMS, email)?";
    const fixed = unescapeLiteralNewlines(reply);
    expect(fixed).toBe(
      "## What I need from you\n- Are appointments shared across multiple salons or restricted to a single location?\n- What kind of notifications do you want for stylists (e.g., SMS, email)?",
    );
    expect(fixed).not.toContain("\\n");
  });

  test("also undoes literal \\t and escaped quotes in the same pass", () => {
    expect(unescapeLiteralNewlines('a\\tb\\nc says \\"hi\\"\\nd')).toBe('a\tb\nc says "hi"\nd');
  });

  test("ordinary markdown with real newlines is left alone", () => {
    const body = "## In short\n- Customers book online.\n- Stylists get alerted.";
    expect(unescapeLiteralNewlines(body)).toBe(body);
  });

  test("a single literal backslash-n inside otherwise normal prose is not treated as escaped JSON", () => {
    const body = "The regex uses \\n to mean newline, but the rest of this reply\nis normal prose\nwith real breaks.";
    expect(unescapeLiteralNewlines(body)).toBe(body);
  });

  test("inline HTML in a reply is untouched — unescaping is only about newlines, never markup", () => {
    const reply = "<ul>\\n<li data-testid=\\\"appointment-form\\\">Book now</li>\\n</ul>";
    const fixed = unescapeLiteralNewlines(reply);
    expect(fixed).toBe('<ul>\n<li data-testid="appointment-form">Book now</li>\n</ul>');
  });
});
