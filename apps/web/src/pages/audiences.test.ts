import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "audiences.tsx"), "utf8");
const index = readFileSync(join(import.meta.dir, "workspace/index.tsx"), "utf8");

describe("stage 5 audience packages", () => {
  test("render as the document pane, not Screen essays", () => {
    expect(source).toContain('className="doc"');
    expect(source).toContain('className="docmeta"');
    expect(source).toContain("<Markdown source={content} />");
    expect(source).toContain("writeOnePackage");
    expect(source).toContain("persistAudiencePackage");
    expect(source).toContain("QuorumChips");
    expect(source).toContain("saveSlides");
    expect(source).toContain("recordAudienceDecision");
    expect(source).not.toContain("<Screen");
    expect(source).not.toContain("Rough cost, not the firm estimate.");
    expect(source).not.toContain("document-fold");
    expect(source).not.toContain("DecisionPanel");
    expect(index).toContain('<div className="stage-inner">');
    expect(index).toContain("<AudiencePackages");
  });
});
