import { describe, expect, test } from "bun:test";
import { IMPORTED_CONVERSATION_KIND } from "../../project-import.ts";
import { HANDOFF_LEAD } from "../../design-handoff.ts";
import type { ChainNode } from "./approved-chain.ts";
import { IMPORTED_LEAD, importedHistory, importedHistoryNodes, renderImportedHistory } from "./imported-history.ts";

const node = (over: Partial<ChainNode> & Pick<ChainNode, "id" | "kind" | "stage">): ChainNode => ({
  title: over.id,
  artifactId: `art_${over.id}`,
  version: 1,
  variant: null,
  supersededByNodeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const conversation = node({ id: "chat-3", kind: IMPORTED_CONVERSATION_KIND, stage: 3, title: "Solution proposal conversation (imported)" });
const v1 = node({ id: "approach-v1", kind: "chosen_approach", stage: 3, title: "Chosen approach v1", createdAt: "2026-01-01T00:01:00.000Z" });
const v3 = node({ id: "approach-v3", kind: "chosen_approach", stage: 3, title: "Chosen approach v3", createdAt: "2026-01-01T00:03:00.000Z" });
const v2 = node({ id: "approach-v2", kind: "chosen_approach", stage: 3, title: "Chosen approach v2", createdAt: "2026-01-01T00:02:00.000Z" });
const brief = node({ id: "brief", kind: "problem_brief", stage: 1 });

// #490: an import turns each stage's chat into a read-only artifact and
// every document into its own version 1; the landed stage continues from them.
describe("importedHistoryNodes", () => {
  test("a project that was not imported, or a stage the export never reached, has none", () => {
    expect(importedHistoryNodes([brief, v1], 3)).toEqual({ conversation: null, draft: null });
    expect(importedHistoryNodes([conversation, v1], 4)).toEqual({ conversation: null, draft: null });
  });

  test("the stage's conversation and the document written last, every version being its own version 1", () => {
    expect(importedHistoryNodes([brief, v1, v3, v2, conversation], 3)).toEqual({ conversation, draft: v3 });
  });

  test("a conversation alone is history too", () => {
    expect(importedHistoryNodes([conversation], 3)).toEqual({ conversation, draft: null });
  });

  test("a superseded version is never the latest", () => {
    const superseded = { ...v3, supersededByNodeId: "later" };
    expect(importedHistoryNodes([conversation, v1, superseded], 3).draft).toEqual(v1);
  });
});

describe("importedHistory", () => {
  const contents: Record<string, string> = {
    "chat-3": "**You** — 2026-01-01\n\nMake leads easier.\n\n---\n\n**Specialist** — 2026-01-01\n\nWhich channel matters most?",
    "approach-v3": "## Chosen approach\n\nPhone first.",
  };
  const read = async (id: string) => {
    const content = contents[id];
    if (content === undefined) throw new Error(`no such artifact ${id}`);
    return { content };
  };

  test("nothing for a project that was not imported", async () => {
    expect(await importedHistory("tnt", [brief, v3], 3, read)).toBe("");
  });

  test("the lead, the transcript and the latest document, in that order", async () => {
    const history = await importedHistory("tnt", [brief, v1, v3, conversation], 3, read);
    expect(history.startsWith(IMPORTED_LEAD)).toBe(true);
    expect(history.indexOf("Which channel matters most?")).toBeGreaterThan(history.indexOf(IMPORTED_LEAD));
    expect(history.indexOf("Phone first.")).toBeGreaterThan(history.indexOf("Which channel matters most?"));
    expect(history).toContain("THE LATEST DOCUMENT (imported: Chosen approach v3); THE NEXT VERSION BUILDS ON IT");
  });

  test("an imported design goes as its text, never its markup", async () => {
    const design = node({ id: "design", kind: "design_artifact", stage: 4 });
    const chat = { ...conversation, id: "chat-4", stage: 4 };
    const readDesign = async (id: string) => ({ content: id === "design" ? "<!doctype html><html><head><title>Leads</title></head><body><h1>Inbox</h1></body></html>" : "**You** — hi" });
    const history = await importedHistory("tnt", [chat, design], 4, readDesign);
    expect(history).toContain("# Leads");
    expect(history).not.toContain("<h1>");
    expect(history).not.toContain(HANDOFF_LEAD);
  });

  test("a read that fails fails the history, never an opening without it", async () => {
    await expect(importedHistory("tnt", [conversation, v1], 3, read)).rejects.toThrow("no such artifact approach-v1");
  });
});

describe("renderImportedHistory", () => {
  test("says when no conversation was recorded, and leaves the document out when there is none", () => {
    const history = renderImportedHistory({ transcript: "", document: null, documentTitle: null });
    expect(history).toContain("(No conversation was recorded.)");
    expect(history).not.toContain("THE LATEST DOCUMENT");
  });
});
