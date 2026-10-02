import { describe, expect, test } from "bun:test";
import { artifactRefIn, spokenReply } from "./document.js";

const DRAFT = [
  "## In short",
  "",
  "- Reviews stay human.",
  "",
  "## Problem statement",
  "",
  "People lose the thread across repositories.",
  "",
  "## What I need from you",
  "",
  "Who approves a merge?",
  "- Option: A person, always",
  "- Option: The agent, when dependencies are ready",
].join("\n");

describe("spokenReply", () => {
  test("a document becomes its first question", () => {
    const out = spokenReply(`${DRAFT}\n\nArtifact: art_123 v6`);
    expect(out).toContain("The draft is beside this. Before I revise it:");
    expect(out).toContain("Who approves a merge?");
    expect(out).toContain("- Option: A person, always");
    expect(out).not.toContain("Problem statement");
    expect(out).not.toContain("Artifact:");
  });

  test("a document with nothing to ask speaks the summary", () => {
    const body = DRAFT.replace(/## What I need from you[\s\S]*$/, "## What I need from you\n\nNone.");
    const out = spokenReply(body);
    expect(out).toContain("Reviews stay human.");
    expect(out).toContain("Nothing I need to ask.");
    expect(out).not.toContain("Problem statement");
  });

  test("a short reply keeps its words and drops the artifact line", () => {
    expect(spokenReply("Before I revise it: who approves?\n\nArtifact: art_9 v2")).toBe("Before I revise it: who approves?");
  });
});

describe("artifactRefIn", () => {
  test("the last line wins", () => {
    expect(artifactRefIn("Artifact: art_1 v1\n\nArtifact: art_1 v4")).toEqual({ id: "art_1", version: 4 });
    expect(artifactRefIn("no artifact here")).toBeNull();
  });
});
