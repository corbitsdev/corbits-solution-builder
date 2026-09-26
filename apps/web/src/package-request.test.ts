import { describe, expect, test } from "bun:test";
import { packageRequest } from "./package-request.ts";

// #115: the request carries the approved design, since the stakeholder's
// own specialist never had the stage's opening.
describe("packageRequest", () => {
  test("names the stakeholder and carries the approved design", () => {
    const body = packageRequest("Mr Finance", "<!doctype html><html><body>design</body></html>");
    expect(body).toStartWith("Write the package for: Mr Finance.\n\nThe approved GUI design this package is built on, for reference:\n\n<!doctype html>");
  });

  test("asks plainly when no design is readable", () => {
    expect(packageRequest("Mr Tech", null)).toBe("Write the package for: Mr Tech.");
    expect(packageRequest("Mr Tech", "  ")).toBe("Write the package for: Mr Tech.");
  });
});
