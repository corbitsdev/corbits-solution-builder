import { describe, expect, test } from "bun:test";
import { draftNode, markdownFileName } from "./document-export.tsx";
import { setPrintProject } from "./print.tsx";

// #242: every stage document exports the same way, drafts at stage 6 included.
describe("document export", () => {
  test("the Markdown file carries the PDF's name with its own extension", () => {
    setPrintProject("Inteva Complete");
    expect(markdownFileName(draftNode("product_requirements", 6, "Product requirements"))).toBe("inteva-complete-product-requirements.md");
    setPrintProject(null);
  });

  test("a draft node names its document and stage the way a recorded one does", () => {
    const node = draftNode("build_plan_review", 6, "Quality review");
    expect(node).toMatchObject({ kind: "build_plan_review", stage: 6, variant: "Quality review", title: "Quality review", version: 1, mediaType: "text/markdown" });
  });
});
