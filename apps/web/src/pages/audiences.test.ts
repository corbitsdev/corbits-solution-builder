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
    // CL-8870: a stakeholder's vote is its own `project.decision` signal on
    // the project workflow run, not an artifact-metadata write.
    expect(source).toContain("recordAudienceVote");
    expect(source).not.toContain("<Screen");
    expect(source).not.toContain("Rough cost, not the firm estimate.");
    expect(source).not.toContain("document-fold");
    expect(source).not.toContain("DecisionPanel");
    expect(index).toContain('<div className="stage-inner">');
    expect(index).toContain("<AudiencePackages");
  });

  // CL-8866: a Proceed/Needs revision/Reject that fails to record was only
  // ever surfaced in the quorum popover's own local `popError`, never the
  // page's "That decision was refused" Banner -- easy to miss, and
  // indistinguishable from the click having done nothing.
  test("a failed decision reaches the page-level Banner, not just the popover", () => {
    const decideFn = source.slice(source.indexOf("const decide = async ("));
    const body = decideFn.slice(0, decideFn.indexOf("\n  return ("));
    expect(body).toContain("} catch (cause) {");
    expect(body).toContain("setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));");
  });
});

// #99: the control that opens the stakeholder editor says what it opens.
describe("the stakeholder editor's control", () => {
  test("is named for what it manages, not a bare Edit", () => {
    expect(source).toContain("Manage stakeholders");
    expect(source).not.toMatch(/>\s*Edit\s*</);
  });
});
