import { describe, expect, test } from "bun:test";
import { packageAsk, packageRequest } from "./package-request.ts";

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

  test("opens with the ask line the reply is found by", () => {
    expect(packageRequest({ name: "You", role: "project_owner" }, null)).toStartWith(packageAsk("You"));
  });
});
