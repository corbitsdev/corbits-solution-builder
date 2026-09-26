import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../stage-mail.ts";
import {
  conversationLead,
  isHtmlDocument,
  isSubstantialDraft,
  latestDesignReply,
  latestSubstantialDraft,
  workspaceGuidance,
} from "./guidance.ts";

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

  test("conversationLead keeps a short status line and drops the headed brief", () => {
    const withLead = [
      "Pulled the brief. Drafting the problem — cutoff timing looks sharpest.",
      "",
      completeDraft,
    ].join("\n");
    expect(conversationLead(withLead)).toBe("Pulled the brief. Drafting the problem — cutoff timing looks sharpest.");
    expect(conversationLead(completeDraft)).toBe("First draft is in the document.");
    expect(conversationLead("Which customer group is first?")).toBe("Which customer group is first?");
  });

  test("a stage-4 HTML mockup is a substantial draft, never dumped raw into chat", () => {
    const html = `<!doctype html>
<html>
<head><style>body{font:1rem sans-serif}</style></head>
<body>
  <ul>
    <li data-testid="appointment-form">Book now</li>
    <li data-testid="stylist-picker">Choose a stylist</li>
  </ul>
  <section data-testid="design-notes">
    <h2>Primary flows</h2>
    <p>Book an appointment end to end.</p>
  </section>
</body>
</html>`;
    expect(isHtmlDocument(html)).toBe(true);
    expect(isSubstantialDraft(html)).toBe(true);
    expect(conversationLead(html)).toBe("First draft is in the document.");
    expect(conversationLead(html)).not.toContain("<ul>");
    expect(conversationLead(html)).not.toContain("<li");
  });

  test("a short reply is not mistaken for an HTML document", () => {
    expect(isHtmlDocument("Thanks — I will update that.")).toBe(false);
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


describe("latestDesignReply", () => {
  const agent = (id: string, body: string): ChatMessage => ({ id, author: "agent", body, at });
  const mockup = `<!doctype html>\n<html lang="en"><head><style>body{margin:0}</style></head><body>${"<section data-testid=\"screen-phone\">Workout Log</section>".repeat(8)}</body></html>`;

  test("the latest HTML document reply is the design, even when later replies are conversation", () => {
    const messages = [person("Design it"), agent("d1", mockup), agent("ack", "Noted: a deadline deletes unreviewed items, so a clock is now in both states.")];
    expect(latestDesignReply(messages)?.id).toBe("d1");
  });

  test("an error reply, a markdown document and a short HTML fragment are never a design (#81)", () => {
    const markdownDoc = ["## In short", "- You chose Approach B", "", "## Fit", "The app stays an iPhone application.", "", "## Risks", "A false station change may split several later sets until reviewed. ".repeat(4)].join("\n");
    const messages = [
      agent("doc", markdownDoc),
      agent("err", "This agent could not complete your request due to an unrecoverable inference error [HTTP 404]: Not found"),
      agent("frag", "<!doctype html><html><body>tiny</body></html>"),
    ];
    expect(latestDesignReply(messages)).toBeNull();
    expect(latestSubstantialDraft(messages)?.id).toBe("doc");
  });

  test("the person's own HTML never counts", () => {
    expect(latestDesignReply([person(mockup)])).toBeNull();
  });
});
