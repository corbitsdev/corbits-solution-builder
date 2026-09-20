import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import { isSubstantialDraft, latestSubstantialDraft, workspaceGuidance } from "./guidance.ts";

const at = "2026-09-19T12:00:00.000Z";
const person = (body: string): ChatMessage => ({ id: "person", author: "me", body, at });
const agent = (id: string, body: string): ChatMessage => ({ id, author: "agent", body, at });

const completeDraft = [
  "# Problem statement",
  "A support team loses hours finding the latest customer context across separate systems. The immediate pain is that a person must copy information from three places before responding, which delays customers and creates inconsistent answers.",
  "",
  "## Success criteria",
  "A teammate can find the current context in one place, understand what is missing, and verify the response path with a representative case. The initial release should make the workflow observable without assuming a particular technical solution.",
  "",
  "## What I need from you",
  "Which customer group is most affected first?",
].join("\n");

describe("workspace guidance", () => {
  test("does not treat an acknowledgement as a draft", () => {
    expect(isSubstantialDraft("Thanks — I will update that.")).toBe(false);
    const guidance = workspaceGuidance(1, [person("Build a CRM"), agent("ack", "Thanks — I will update that.")]);
    expect(guidance.title).toBe("A reply needs clarification");
    expect(guidance.draft).toBeNull();
  });

  test("retains a prior substantial draft when a later reply asks a question", () => {
    const messages = [
      person("Build a CRM"),
      agent("draft", completeDraft),
      agent("question", "Which customer group should be the first priority?"),
    ];
    const guidance = workspaceGuidance(1, messages);
    expect(latestSubstantialDraft(messages)?.id).toBe("draft");
    expect(guidance.draft?.id).toBe("draft");
    expect(guidance.question).toEqual({
      text: "Which customer group should be the first priority?",
      choices: [],
    });
  });

  test("extracts recorded choices without inventing alternatives", () => {
    const guidance = workspaceGuidance(3, [
      agent(
        "choice",
        [
          "The two approaches differ in operational ownership.",
          "",
          "Which approach fits your team?",
          "1. Hosted service",
          "2. Self-managed deployment",
        ].join("\n"),
      ),
    ]);
    expect(guidance.question).toEqual({
      text: "Which approach fits your team?",
      choices: ["Hosted service", "Self-managed deployment"],
    });
  });

  test("marks an unanswered person message as waiting rather than working", () => {
    const guidance = workspaceGuidance(8, [person("Start with the approved target.")]);
    expect(guidance.title).toBe("Waiting for a reply");
    expect(guidance.detail).toContain("no specialist reply is visible");
  });

  test("covers every stage with a specific read-only next action", () => {
    for (let stage = 1; stage <= 9; stage++) {
      const guidance = workspaceGuidance(stage, []);
      expect(guidance.title).toBe("Start the conversation");
      expect(guidance.detail).not.toContain("undefined");
    }
  });
});

