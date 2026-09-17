import { describe, expect, test } from "bun:test";
import { printableDesign } from "@solutions-builder/tools-deck/print-page";

describe("@solutions-builder/tools-deck/print-page", () => {
  test("the package export resolves and wraps a design for print", () => {
    const page = printableDesign({
      html: "<html><body><p>design</p></body></html>",
      title: "Northwind",
      version: 2,
      fileName: "northwind-design",
    });
    expect(page.body).toContain("northwind-design");
    expect(page.body).toContain("Print or save as PDF");
    expect(page.headers["content-type"]).toContain("text/html");
  });
});
