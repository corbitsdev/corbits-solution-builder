import { describe, expect, test } from "bun:test";
import { packageAsk, packageNudge, packageReplyProblem, packageRequest } from "./package-request.ts";

// #41 step 3: the request names the stakeholder and their role, since the
// one stage 5 specialist's prompt names nobody. #115: it carries the
// approved design, since the specialist's opening may be out of reach.
describe("packageRequest", () => {
  test("names the stakeholder and role, and carries a Markdown design as it is", () => {
    const body = packageRequest({ name: "Mr Finance", role: "budget_approver" }, "## Design\n\nThree tabs.");
    expect(body).toBe("Write the package for: Mr Finance, the budget approver.\n\nThe approved GUI design this package is built on, for reference:\n\n## Design\n\nThree tabs.");
  });

  // #219: an HTML mockup mailed verbatim came back as HTML, not a package.
  test("carries an HTML design as its text in a labelled block, never as markup", () => {
    const body = packageRequest({ name: "Mr Finance", role: "budget_approver" }, "<!doctype html><html><head><title>Mockup</title></head><body><h2>Phone</h2><p>Three tabs.</p></body></html>");
    expect(body).toStartWith("Write the package for: Mr Finance, the budget approver.\n\nThe approved GUI design this package is built on, for reference:\n\nThe approved design is an HTML mockup");
    expect(body).toContain("```text\n# Mockup\n\n## Phone\n\nThree tabs.\n```");
    expect(body).not.toContain("<h2>");
  });

  test("asks plainly when no design is readable", () => {
    expect(packageRequest({ name: "Mr Tech", role: "security_reviewer" }, null)).toBe("Write the package for: Mr Tech, the security reviewer.");
    expect(packageRequest({ name: "Mr Tech", role: "security_reviewer" }, "  ")).toBe("Write the package for: Mr Tech, the security reviewer.");
  });

  test("a reply with a deck outline is a package; one without is refused with the reason", () => {
    const pkg = "## Audience: Mr Finance\n### One-pager\nWorth it.\n### Deck outline\n1. **Problem: costs** — Manual work.\n2. **Solution** — The app.\n### Decision request\nProceed.";
    expect(packageReplyProblem("Mr Finance", pkg)).toBeNull();
    expect(packageReplyProblem("Mr Finance", "The deck for Mr Finance has rendered as slides.pptx — nine slides.")).toBe(
      "Mr Finance's package was not written: the reply it has no \"### Deck outline\" section, and a package's slides are built from that outline. Ask for it again.",
    );
    expect(packageReplyProblem("Mr Tech", "### Deck outline\n\nSome prose, no numbered slides.")).toStartWith("Mr Tech's package was not written: the reply its \"### Deck outline\" section has no numbered slides");
  });

  // #225: the follow-up after a reply that was not a package opens with the
  // same ask line, so its reply is paired the same way, and says where the
  // package has to be.
  test("the nudge re-asks by the same line and says the reply itself is the package", () => {
    const nudge = packageNudge({ name: "You", role: "project_owner" }, 'it has no "### Deck outline" section');
    expect(nudge).toStartWith(packageAsk("You"));
    expect(nudge).toContain("Your last reply was not the package: it has no \"### Deck outline\" section.");
    expect(nudge).toContain("in this reply");
    expect(nudge).toContain("Markdown handed to render_deck is not read as the package.");
  });

  // #246: the design documents that apply to the project ride in the
  // request — the specialist's prompt is fixed at deploy, so the mail is
  // the only way in. #285: the theme does not; the interface draws with it.
  test("carries the deck's brief after the design: the guidelines block, and no theme", () => {
    const body = packageRequest(
      { name: "Mr Finance", role: "budget_approver" },
      "## Design\n\nThree tabs.",
      { theme: { accent: "1E3A8A" }, guidelines: "--- DESIGN GUIDELINES FOR THE DECK ---\n\n### house.md (the workspace's)\nNavy and white.", documents: ["house.md"] },
    );
    expect(body).toBe(
      "Write the package for: Mr Finance, the budget approver.\n\nThe approved GUI design this package is built on, for reference:\n\n## Design\n\nThree tabs.\n\n--- DESIGN GUIDELINES FOR THE DECK ---\n\n### house.md (the workspace's)\nNavy and white.",
    );
    expect(body).not.toContain("1E3A8A");
  });

  test("a brief with nothing in it adds nothing", () => {
    expect(packageRequest({ name: "Mr Tech", role: "security_reviewer" }, null, { theme: null, guidelines: null, documents: [] })).toBe("Write the package for: Mr Tech, the security reviewer.");
  });

  test("opens with the ask line the reply is found by", () => {
    expect(packageRequest({ name: "You", role: "project_owner" }, null)).toStartWith(packageAsk("You"));
  });
});
