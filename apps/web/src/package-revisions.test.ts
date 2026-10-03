import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.js";
import type { ChatMessage } from "./stage-mail.ts";
import { unrecordedPackageRevisions } from "./package-revisions.ts";
import { appSubject } from "./pages/workspace/composed-mail.ts";

const PKG = "## In short\n\n- x\n\n### Deck outline\n\n1. **Problem**\n   Lines.\n2. **What it looks like** (screen: gantt loading)\n   The Gantt.\n\n### Decision request\n\nProceed?";
const msg = (id: string, author: "me" | "agent", body: string, at: string): ChatMessage => ({ id, author, body, at });
const node = (variant: string, createdAt: string): ArtifactNode =>
  ({ id: `n-${variant}-${createdAt}`, kind: "audience_package", variant, stage: 5, title: variant, version: 1, artifactId: "a", contentHash: "", createdAt, supersededByNodeId: null, provenance: { producer: "agent" } }) as ArtifactNode;
const ask = (id: string, name: string, at: string): ChatMessage => ({ ...msg(id, "me", "Write the package.", at), subject: appSubject("package", name) });
const audiences = [{ name: "You" }, { name: "Tim Burke" }];

// #597: a package rewritten on request in the chat is the next version.
describe("unrecordedPackageRevisions", () => {
  test("a reply with a deck outline after the recorded head, in a stakeholder's conversation, is unrecorded; the recorded reply is not", () => {
    const messages = [
      ask("ask", "You", "2026-10-03T10:00:00Z"),
      msg("first", "agent", PKG, "2026-10-03T10:01:00Z"),
      msg("you1", "me", "I require the Gantt on the What it looks like slide.", "2026-10-03T10:10:00Z"),
      msg("rev1", "agent", PKG, "2026-10-03T10:11:00Z"),
      msg("you2", "me", "rewrite the slides with the Gantt chart in it", "2026-10-03T10:20:00Z"),
      msg("rev2", "agent", PKG, "2026-10-03T10:21:00Z"),
    ];
    const packages = [node("You", "2026-10-03T10:01:30Z")];
    expect(unrecordedPackageRevisions(messages, packages, audiences).map((r) => [r.name, r.message.id])).toEqual([["You", "rev2"]]);
    expect(unrecordedPackageRevisions(messages.slice(0, 2), packages, audiences)).toEqual([]);
  });

  test("a reply with no deck outline, or before any package was asked for, is not a package", () => {
    const messages = [
      msg("hello", "agent", "Noted. What should change?", "2026-10-03T09:00:00Z"),
      ask("ask", "Tim Burke", "2026-10-03T10:00:00Z"),
      msg("q", "agent", "Which currency should the cost use?", "2026-10-03T10:01:00Z"),
    ];
    expect(unrecordedPackageRevisions(messages, [], audiences)).toEqual([]);
  });

  test("the conversation moves to the stakeholder last asked for", () => {
    const messages = [
      ask("a1", "You", "2026-10-03T10:00:00Z"),
      ask("a2", "Tim Burke", "2026-10-03T10:00:01Z"),
      msg("r", "agent", PKG, "2026-10-03T10:02:00Z"),
    ];
    expect(unrecordedPackageRevisions(messages, [], audiences).map((r) => r.name)).toEqual(["Tim Burke"]);
  });
});
