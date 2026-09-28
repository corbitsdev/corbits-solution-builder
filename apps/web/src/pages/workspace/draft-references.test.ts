import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import { draftReferences } from "./draft-references.ts";

const DRAFT = [
  "Here is the brief.",
  "",
  "# Problem brief",
  "",
  "## In short",
  "",
  "Field crews lose an hour a day re-entering readings that the handheld already captured, because the sync drops on the way back to the depot.",
  "",
  "## Who is affected",
  "",
  "Every crew lead across the twelve depots, and the dispatchers who chase the missing readings each evening before the report is due.",
].join("\n");

function message(id: string, author: "me" | "agent", body: string, at: string): ChatMessage {
  return { id, author, body, at };
}

function node(id: string, version: number, createdAt: string): ArtifactNode {
  return {
    id,
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Problem brief",
    version,
    artifactId: "art_1",
    contentHash: `art_1@${version}`,
    createdAt,
    supersededByNodeId: null,
    provenance: { producer: "specialist" },
  };
}

describe("draftReferences", () => {
  test("pairs each draft reply with the version written after it, and the latest with the pane's unpersisted head", () => {
    const refs = draftReferences(
      [
        message("m1", "me", "Start", "2026-09-28T10:00:00.000Z"),
        message("m2", "agent", DRAFT, "2026-09-28T10:01:00.000Z"),
        message("m3", "me", "Name the depots.", "2026-09-28T10:05:00.000Z"),
        message("m4", "agent", DRAFT.replace("twelve", "fourteen"), "2026-09-28T10:06:00.000Z"),
      ],
      [node("n1", 1, "2026-09-28T10:01:30.000Z"), node("reply:m4", 2, "2026-09-28T10:06:00.000Z")],
      "problem brief",
    );
    expect(refs.get("m2")).toEqual({ version: 1, nodeId: "n1", noun: "problem brief" });
    expect(refs.get("m4")).toEqual({ version: 2, nodeId: "reply:m4", noun: "problem brief" });
    expect(refs.has("m1")).toBe(false);
    expect(refs.has("m3")).toBe(false);
  });

  test("a draft whose version is not recorded yet still gets a line, with nothing to open", () => {
    const refs = draftReferences([message("m2", "agent", DRAFT, "2026-09-28T10:01:00.000Z")], [], "problem brief");
    expect(refs.get("m2")).toEqual({ version: null, nodeId: null, noun: "problem brief" });
  });

  test("a version written before the draft is never taken as that draft's", () => {
    const refs = draftReferences(
      [message("m2", "agent", DRAFT, "2026-09-28T10:01:00.000Z")],
      [node("n0", 1, "2026-09-28T09:00:00.000Z")],
      "problem brief",
    );
    expect(refs.get("m2")).toEqual({ version: null, nodeId: null, noun: "problem brief" });
  });

  test("a question or a plain reply is not a draft", () => {
    const refs = draftReferences(
      [
        message("q", "agent", "Which depots first?\n\n- Option: North\n- Option: South", "2026-09-28T10:01:00.000Z"),
        message("a", "agent", "Noted, thanks.", "2026-09-28T10:02:00.000Z"),
      ],
      [node("n1", 1, "2026-09-28T10:01:30.000Z")],
      "problem brief",
    );
    expect(refs.size).toBe(0);
  });
});
