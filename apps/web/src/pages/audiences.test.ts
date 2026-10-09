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
    // #220: a reply with no deck outline is refused before anything is recorded.
    const writeOne = source.slice(source.indexOf("const writeOnePackage = async ("));
    expect(writeOne.indexOf("packageReplyProblem(name, reply.body)")).toBeGreaterThan(-1);
    expect(writeOne.indexOf("packageReplyProblem(name, reply.body)")).toBeLessThan(writeOne.indexOf("persistAudiencePackage("));
    // #225: one re-ask in the same thread before the miss is reported.
    expect(writeOne.indexOf("packageNudge(audience,")).toBeGreaterThan(-1);
    expect(writeOne.indexOf("packageNudge(audience,")).toBeLessThan(writeOne.indexOf("persistAudiencePackage("));
    expect(source).toContain("QuorumChips");
    // #725: the gate is not in the pane; it sits above the chat box as
    // `AudienceGate`, and one click proceeds and approves for a sole "You".
    expect(source).not.toContain("audience-gate");
    expect(source.indexOf("\n          Approve and continue\n")).toBeGreaterThan(source.indexOf("export function AudienceGate("));
    expect(source).toContain('const solo = audiences.length === 1 && isYou(audiences[0]!) && requiredQuorum <= 1;');
    expect(source).toContain('decision: "proceed",');
    expect(index).toContain("{stage === 5 ? (\n            <AudienceGate");
    // #232: one export menu with three ways out replaces the one save button.
    expect(source).toContain("exportSlides");
    expect(source).not.toContain("Save slides (.pptx)");
    for (const item of ["Open in Google Slides", "Save as PPTX", "Save as PDF"]) expect(source).toContain(item);
    expect(source).toContain('exportSlides(selected.id, "pdf")');
    expect(source).toContain("printHtmlDocument(slidesPrintHtml(");
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

  // #678: a disclosure, in place whether the panel is open or closed, that
  // toggles it. #722: styled as a control, the repo's Button, not a bare
  // text button that reads as a label.
  test("is a Button that discloses the panel, and says so to assistive tech", () => {
    expect(source).toMatch(/<Button aria-expanded=\{editing\} aria-controls="stakeholder-panel" onClick=\{\(\) => setEditing\(!editing\)\}>/);
    expect(source).not.toContain('className="disclosure"');
    expect(source).toContain('<div className="stakeholder-editor" id="stakeholder-panel">');
  });
});

// #722: the panel's controls say what they make, and a sole approver never
// waits on a button for the one package there is.
describe("the package controls", () => {
  test("say what they generate, not \"Write it\"", () => {
    expect(source).toContain("Generate approval package");
    expect(source).toContain("Generate the package again");
    expect(source).toContain("Generate all {missing.length} packages");
    expect(source).not.toMatch(/>\s*Write it\s*</);
    expect(source).not.toContain('"Write it again"');
  });

  test("a one-approver policy just saved writes that approver's package at once", () => {
    // Armed only by the editor's save, never on mount, through a ref one
    // save sets and one write clears.
    expect(source).toContain("const autoWriteRef = useRef<string | null>(null);");
    expect(source).toContain("autoWriteRef.current = saved.audiences.length === 1 ? saved.audiences[0]!.name : null;");
    expect(source).toContain("armAutoWrite(saved);");
    const effect = source.slice(source.indexOf("const name = autoWriteRef.current;"));
    // Never while a round is in flight; cleared before the write so it fires once.
    expect(effect.indexOf("if (name === null || writing.size > 0) return;")).toBeLessThan(effect.indexOf("autoWriteRef.current = null;"));
    expect(effect.indexOf("autoWriteRef.current = null;")).toBeLessThan(effect.indexOf("void writePackages([name]);"));
    // The editor's save hands the policy as saved to both listeners.
    expect(source).toContain("const saved = await api.setStakeholders(projectId, { audiences: rows, audienceQuorum: needed });");
    expect(source).toContain("onSaved?.(saved);");
    expect(source).toContain("onStakeholdersSaved?.();");
  });
});
