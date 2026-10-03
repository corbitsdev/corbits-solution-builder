import { describe, expect, test } from "bun:test";
import { approvedChainNodes, chainContent, renderApprovedChain, splitChain, type ChainNode } from "./approved-chain.ts";

const node = (over: Partial<ChainNode> & Pick<ChainNode, "id" | "kind" | "stage">): ChainNode => ({
  title: over.id,
  artifactId: `art_${over.id}`,
  version: 1,
  variant: null,
  supersededByNodeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const approved = (artifactId: string, version: number) => ({ reviewId: "r", artifactId, version, sha256: "0".repeat(64), status: "approved" as const });

describe("approvedChainNodes", () => {
  test("hands over the one approved version per earlier stage, not every draft, and not the previous stage's", () => {
    const nodes = [
      node({ id: "brief-v1", kind: "problem_brief", stage: 1, artifactId: "art_brief", version: 1, supersededByNodeId: "brief-v2" }),
      node({ id: "brief-v2", kind: "problem_brief", stage: 1, artifactId: "art_brief", version: 2, supersededByNodeId: "brief-v3" }),
      node({ id: "brief-v3", kind: "problem_brief", stage: 1, artifactId: "art_brief", version: 3 }),
      node({ id: "constraints-v1", kind: "solution_constraints", stage: 2, artifactId: "art_constraints", version: 1 }),
      node({ id: "approach-draft", kind: "chosen_approach", stage: 3 }),
    ];
    // The person approved brief v2, then revised to v3 without re-approving.
    const reviews = { 1: approved("art_brief", 2), 2: approved("art_constraints", 1) };
    expect(approvedChainNodes(nodes, reviews, 4).map((entry) => entry.id)).toEqual(["brief-v2", "constraints-v1"]);
    // Stage 3 opens on the constraints themselves; the chain carries only the brief.
    expect(approvedChainNodes(nodes, reviews, 3).map((entry) => entry.id)).toEqual(["brief-v2"]);
  });

  test("a stage whose review is open or absent contributes nothing", () => {
    const nodes = [node({ id: "brief", kind: "problem_brief", stage: 1, artifactId: "art_brief" })];
    expect(approvedChainNodes(nodes, { 1: { ...approved("art_brief", 1), status: "open" } }, 3)).toEqual([]);
    expect(approvedChainNodes(nodes, {}, 3)).toEqual([]);
  });

  test("the opening statement and each attached file's reading come first, oldest first", () => {
    const nodes = [
      node({ id: "brief", kind: "problem_brief", stage: 1, artifactId: "art_brief" }),
      node({ id: "reading", kind: "material_reading", stage: 1, variant: "deck.pdf", createdAt: "2026-01-01T00:00:02.000Z" }),
      node({ id: "opening", kind: "source_material", stage: 1, variant: "__opening__", createdAt: "2026-01-01T00:00:01.000Z" }),
      node({ id: "upload", kind: "source_material", stage: 1, variant: "deck.pdf" }),
    ];
    expect(approvedChainNodes(nodes, { 1: approved("art_brief", 1) }, 3).map((entry) => entry.id)).toEqual(["opening", "reading", "brief"]);
  });

  test("stage 1 opens on the problem statement itself, so its record carries only the readings", () => {
    const nodes = [
      node({ id: "opening", kind: "source_material", stage: 1, variant: "__opening__" }),
      node({ id: "reading", kind: "material_reading", stage: 1, variant: "deck.pdf" }),
    ];
    expect(approvedChainNodes(nodes, {}, 1).map((entry) => entry.id)).toEqual(["reading"]);
    expect(approvedChainNodes([nodes[0]!], {}, 1)).toEqual([]);
  });
});

describe("renderApprovedChain", () => {
  test("labels material and approved inputs the way main's draft prompt did", () => {
    const text = renderApprovedChain(
      [
        { node: { id: "o", title: "Opening", kind: "source_material", stage: 1 }, content: "Make leads easier." },
        { node: { id: "b", title: "Problem brief", kind: "problem_brief", stage: 1 }, content: "## In short\n- leads" },
      ],
      3,
    );
    expect(text).toContain("--- MATERIAL THE PERSON PROVIDED: Opening ---");
    expect(text).toContain("--- APPROVED INPUT: Problem brief (stage 1, problem_brief) ---");
  });

  test("nothing to hand over renders nothing", () => {
    expect(renderApprovedChain([], 2)).toBe("");
  });

  test("the transcript splits an opening back into the record and the stage's own lead", () => {
    const chain = renderApprovedChain([{ node: { id: "b", title: "Brief", kind: "problem_brief", stage: 1 }, content: "body" }], 2);
    const split = splitChain(`Language: write in English.\n\n${chain}\n\n## In short\n- the constraints`);
    expect(split?.before).toBe("Language: write in English.");
    expect(split?.chain).toContain("--- APPROVED INPUT: Brief (stage 1, problem_brief) ---");
    expect(split?.after).toBe("## In short\n- the constraints");
    expect(splitChain("an ordinary message")).toBeNull();
  });
});

describe("chainContent", () => {
  test("a design goes as its text, a document as it is", () => {
    expect(chainContent("<!doctype html><html><body><h1>Home</h1><p>Hello</p></body></html>")).toContain("# Home");
    expect(chainContent("## In short\n- fine")).toBe("## In short\n- fine");
  });
});
