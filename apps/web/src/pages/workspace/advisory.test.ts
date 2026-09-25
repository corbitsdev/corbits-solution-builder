import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../../stage-mail.ts";
import { answerTo, evaluatorStateOf } from "./use-advisory.ts";
import { EvaluatorVerdict } from "./workspace-chrome.tsx";
import { GuideDock, GuideExplanation } from "../../components.tsx";
import { budgetVersions, textOf, deterministicGuidance, guidancePrompt, guideStep, guideVersionNodes, parseGuidanceReply, type GuideContext } from "./product-guide.ts";
import type { ArtifactNode } from "../../client.ts";
import type { ProjectWorkflowView } from "../../project-workflow.ts";

const message = (author: ChatMessage["author"], at: string, body = "…"): ChatMessage => ({ id: at, author, at, body });

describe("answerTo", () => {
  let n = 0;
  const say = (author: ChatMessage["author"], body: string): ChatMessage => {
    n += 1;
    return { id: `m${n}`, author, body, at: `2026-09-25T10:00:${String(n).padStart(2, "0")}.000Z` };
  };

  test("is null until the request has been sent", () => {
    expect(answerTo([say("me", "Draft A")], "Draft B")).toBeNull();
  });

  test("a late verdict on draft A is never taken as draft B's", () => {
    const a = say("me", "Draft A");
    const b = say("me", "Draft B");
    const verdictOnA = say("agent", "Verdict: ready");
    expect(answerTo([a, b, verdictOnA], "Draft B")).toMatchObject({ request: { id: b.id }, reply: null });
    const verdictOnB = say("agent", "Verdict: not yet");
    expect(answerTo([a, b, verdictOnA, verdictOnB], "Draft B")?.reply?.id).toBe(verdictOnB.id);
  });

  test("a request already sent is found again, so it is not re-sent", () => {
    const sent = say("me", "Draft A\n");
    expect(answerTo([sent], "Draft A")?.request.id).toBe(sent.id);
  });

  test("asking again with the same words waits for the newer answer", () => {
    const first = say("me", "Where does this stand?");
    const firstReply = say("agent", "## Where this stands\nEarly.");
    const again = say("me", "Where does this stand?");
    expect(answerTo([first, firstReply, again], "Where does this stand?")).toMatchObject({ request: { id: again.id }, reply: null });
  });
});

describe("evaluatorStateOf", () => {
  const reply = (body: string): ChatMessage => ({ id: "r", author: "agent", body, at: "2026-09-25T10:00:00.000Z" });

  test("reads a verdict and its notes", () => {
    expect(evaluatorStateOf(reply("Verdict: ready\n- Clear success criteria"))).toEqual({ status: "verdict", verdict: { ready: true, notes: ["Clear success criteria"] } });
  });

  test("quotes what the evaluator said when it is not a verdict", () => {
    expect(evaluatorStateOf(reply("This agent encountered a temporary error communicating with the inference provider"))).toEqual({
      status: "unavailable",
      reason: "The brief evaluator could not judge this draft: This agent encountered a temporary error communicating with the inference provider",
    });
  });
});

describe("EvaluatorVerdict", () => {
  const render = (evaluator: Parameters<typeof EvaluatorVerdict>[0]["evaluator"]) =>
    renderToStaticMarkup(createElement(EvaluatorVerdict, { evaluator }));

  test("renders nothing when there is no draft to judge", () => {
    expect(render({ status: "idle" })).toBe("");
  });

  test("says it is reading while the verdict is pending", () => {
    expect(render({ status: "checking" })).toContain("reading this draft");
  });

  test("shows the verdict and its notes", () => {
    const html = render({ status: "verdict", verdict: { ready: false, notes: ["Success criteria are vague."] } });
    expect(html).toContain("not yet");
    expect(html).toContain("Success criteria are vague.");
  });

  test("says why when it is unavailable, never silently", () => {
    expect(render({ status: "unavailable", reason: "The brief evaluator has not answered yet." })).toContain("unavailable. The brief evaluator has not answered yet.");
  });
});

describe("the Product guide", () => {
  const node = (id: string, stage: number, title: string, superseded: string | null = null) =>
    ({ id, stage, title, kind: "problem_brief", version: 1, supersededByNodeId: superseded }) as unknown as ArtifactNode;
  const view = {
    done: false,
    openReview: { reviewId: "stage-2-review-1", artifactId: "a2", version: 1, sha256: "s", status: "open" },
    reviews: { 1: { status: "approved" } },
    decisions: [
      { decisionId: "d1", kind: "approve", stage: 1, accepted: true, principalId: "p", at: "t" },
      { decisionId: "d2", kind: "approve", stage: 2, accepted: false, reason: "stale_review", principalId: "p", at: "t" },
    ],
    audiencePolicy: null,
    audienceDecisions: {},
  } as unknown as ProjectWorkflowView;
  const context: GuideContext = { projectTitle: "Invoice reconciliation", stage: 2, view, nodes: [node("n1", 1, "Problem brief"), node("n0", 1, "Old brief", "n1")] };

  test("the request carries each live version's content and the recorded decisions", () => {
    const prompt = guidancePrompt(context, [{ id: "n1", title: "Problem brief", stage: 1, content: "Four hours every Friday." }]);
    expect(prompt).toContain("Project: Invoice reconciliation");
    expect(prompt).toContain("Current stage: 2 of 9. Run state: waiting_approval.");
    expect(prompt).toContain("--- VERSION n1 — Problem brief (stage 1) ---\nFour hours every Friday.");
    expect(prompt).toContain("Recorded decisions: stage 1 approve");
    expect(prompt).not.toContain("stale_review");
  });

  test("a reply is read into summary, missing, options, recommended, questions and its sources", () => {
    const parsed = parseGuidanceReply(
      "## Where this stands\nThe brief is approved.\n## What is missing\n- Constraints on the bank export\n## Your options\n- Approve the shape — it matches the brief\n## Recommended next step\nApprove the shape\n## Questions\n- Which bank?",
      [{ id: "n1", title: "Problem brief", stage: 1, content: "" }],
    );
    expect(parsed).toMatchObject({
      summary: "The brief is approved.",
      missing: ["Constraints on the bank export"],
      options: [{ label: "Approve the shape", detail: "it matches the brief" }],
      recommended: "Approve the shape",
      questions: ["Which bank?"],
      sourceVersionIds: ["n1"],
      origin: "agent",
    });
  });

  test("reads text versions only, the current stage first", () => {
    const nodes = [
      node("b1", 1, "Problem brief"),
      { ...node("u1", 1, "Upload"), kind: "source_material" } as ArtifactNode,
      { ...node("r1", 1, "Upload text"), kind: "material_reading" } as ArtifactNode,
      { ...node("x8", 8, "Archive"), kind: "build_evidence" } as ArtifactNode,
      node("s2", 2, "Constraints"),
      node("old", 2, "Superseded", "s2"),
    ];
    expect(guideVersionNodes(nodes, 2).map((entry) => entry.id)).toEqual(["s2", "b1", "r1"]);
  });

  test("cites only what it sent, within one budget", () => {
    const version = (id: string, content: string) => ({ id, title: id, stage: 1, content });
    const sent = budgetVersions([
      version("empty", "  "),
      version("upload", "data:application/pdf;base64,JVBERi0x"),
      ...Array.from({ length: 8 }, (_, index) => version(`v${index}`, "x".repeat(5_000))),
    ]);
    expect(sent.map((entry) => entry.id)).toEqual(["v0", "v1", "v2", "v3", "v4", "v5"]);
    expect(sent.every((entry) => entry.content.length === 4_000)).toBe(true);
  });

  test("designs and decks written as HTML are read as their words", () => {
    expect(textOf('<!doctype html><html><head><style>.a{}</style></head><body><h1>Reconcile</h1><p>Upload a CSV &amp; match</p></body></html>')).toBe("Reconcile Upload a CSV & match");
    expect(textOf("# Plain markdown <b>kept</b>")).toBe("# Plain markdown <b>kept</b>");
  });

  test("markup is found past a comment, an XML declaration or a fence, and by kind", () => {
    expect(textOf("<!-- mockup --><div><p>Upload</p></div>")).toBe("Upload");
    expect(textOf('<?xml version="1.0"?><svg><text>Chart</text></svg>')).toBe("Chart");
    expect(textOf("```html\n<section><h2>Match</h2></section>\n```")).toBe("Match");
    expect(textOf("Plain words <em>kept</em>", "design_artifact")).toBe("Plain words kept");
  });

  test("entities decode once, attributes never leak, and an unclosed script is dropped", () => {
    expect(textOf("<p>&amp;lt;b&amp;gt; &quot;q&quot; &#39;s&#39; &#x2713;</p>")).toBe('&lt;b&gt; "q" \'s\' ✓');
    expect(textOf('<p title="a > b">Shown</p>')).toBe("Shown");
    expect(textOf("<div>Kept</div><script>var hidden = 1;")).toBe("Kept");
  });

  test("a numeric entity no string can hold is read as a replacement character, never an error", () => {
    expect(textOf("<p>a&#x110000;b&#99999999;c&#xD800;d&#0;e</p>")).toBe("a\uFFFDb\uFFFDc\uFFFDd\uFFFDe");
    expect(budgetVersions([{ id: "v", title: "v", stage: 4, kind: "design_artifact", content: "<p>&#x110000;</p>" }])).toHaveLength(1);
  });

  test("markup cut at the cap never leaks a half tag", () => {
    const text = textOf(`<div>${"word ".repeat(12_000)}</div><a title="secret attribute`);
    expect(text).not.toContain("secret");
  });

  test("a later version that fits whole is still sent after one that would not", () => {
    const version = (id: string, length: number) => ({ id, title: id, stage: 1, content: "x".repeat(length) });
    const sent = budgetVersions([...Array.from({ length: 5 }, (_, index) => version(`v${index}`, 4_000)), version("near", 3_800), version("big", 4_000), version("small", 150)]);
    expect(sent.map((entry) => entry.id)).toEqual(["v0", "v1", "v2", "v3", "v4", "near", "small"]);
  });

  test("a version that would only get a sliver of the budget is not cited", () => {
    const version = (id: string, length: number) => ({ id, title: id, stage: 1, content: "x".repeat(length) });
    const sent = budgetVersions([...Array.from({ length: 5 }, (_, index) => version(`v${index}`, 4_000)), version("tail", 3_800), version("sliver", 4_000)]);
    expect(sent.map((entry) => entry.id)).toEqual(["v0", "v1", "v2", "v3", "v4", "tail"]);
    expect(sent.find((entry) => entry.id === "sliver")).toBeUndefined();
  });

  test("numbered options read the same as bulleted ones", () => {
    const parsed = parseGuidanceReply("## Where this stands\nStarted.\n## Your options\n1. Gather the bank exports\n2) Define the matching rules", []);
    expect(parsed?.options.map((option) => option.label)).toEqual(["Gather the bank exports", "Define the matching rules"]);
  });

  test("the floored step follows the workflow's state", () => {
    expect(guideStep(context).where).toBeDefined();
    expect(deterministicGuidance(context).origin).toBe("deterministic");
  });

  const render = (props: Partial<Parameters<typeof GuideDock>[0]>) =>
    renderToStaticMarkup(createElement(GuideDock, { step: guideStep(context), onGo: () => undefined, onExplain: () => undefined, stage: 2, ...props }));

  test("the floating guide offers to explain before it has been asked", () => {
    expect(render({ guidance: null })).toContain('aria-expanded="false"');
  });

  test("says which versions the guide read, or why the checklist stands in", () => {
    const floor = deterministicGuidance(context);
    const answered = { ...floor, origin: "agent" as const, sourceVersionIds: ["n1"] };
    expect(renderToStaticMarkup(createElement(GuideExplanation, { guidance: answered, note: null }))).toContain("Read from 1 version.");
    const failed = renderToStaticMarkup(createElement(GuideExplanation, { guidance: floor, note: "The guide could not be reached: offline" }));
    expect(failed).toContain("The guide gave no answer, so this is the checklist");
    expect(failed).toContain("The guide could not be reached: offline");
  });
});

describe("the workspace", () => {
  const index = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

  // A source check, not a render: it catches the two agents' call sites being
  // dropped again, as they once were, without mounting the workspace.
  test("the workspace source still calls both agents' hooks and renders them", () => {
    expect(index).toContain("useProductGuide(");
    expect(index).toContain("<GuideDock");
    expect(index).toContain("onExplain={() => void guide.explain()}");
    expect(index).toContain("useStageEvaluator(");
    expect(index).toContain("<EvaluatorVerdict evaluator={evaluator} />");
  });
});
