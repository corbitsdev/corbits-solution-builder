import { describe, expect, test } from "bun:test";
import { ATTACHED_HEADING, documentAsMessage, mentionedDocuments, requirementsDocument, reviewDocument, withAttachedDocuments } from "./document-mentions.ts";

const prd = requirementsDocument("# Product requirements\n\nFR-1 …");
const app = reviewDocument("Application", "## Verdict\n\nacceptable with conditions");
const sec = reviewDocument("Security", "## Verdict\n\nrevision required");

describe("mentionedDocuments", () => {
  test("names the PRD and a reviewer however the person puts it", () => {
    expect(mentionedDocuments("Using the feedback from the application reviewer, please revise the PRD", [prd, app, sec]).map((d) => d.key)).toEqual(["requirements", "review:application"]);
    expect(mentionedDocuments("fold the Security review's blocking findings in", [prd, app, sec]).map((d) => d.key)).toEqual(["review:security"]);
    expect(mentionedDocuments("make the Gantt wider", [prd, app, sec])).toEqual([]);
  });

  test("a generic 'the review' means the one review there is, and nothing when there are several", () => {
    expect(mentionedDocuments("carry the reviewer's feedback as risks", [prd, app]).map((d) => d.key)).toEqual(["review:application"]);
    expect(mentionedDocuments("carry the reviewer's feedback as risks", [prd, app, sec])).toEqual([]);
  });
});

describe("withAttachedDocuments", () => {
  test("appends each named document once under its heading, and leaves an unrelated message alone", () => {
    const out = withAttachedDocuments("Revise the PRD using the application review.", [prd, app, sec]);
    expect(out.startsWith("Revise the PRD using the application review.\n\n---\n\n")).toBe(true);
    expect(out).toContain(`${ATTACHED_HEADING} Product requirements\n\n# Product requirements`);
    expect(out).toContain(`${ATTACHED_HEADING} Application review\n\n## Verdict`);
    expect(out).not.toContain("Security");
    expect(withAttachedDocuments("make the Gantt wider", [prd, app])).toBe("make the Gantt wider");
    expect(withAttachedDocuments(out, [prd, app, sec])).toBe(out);
  });

  test("a document sent on its own says what it is", () => {
    expect(documentAsMessage(app)).toBe(`Here is the Application review, for your reference.\n\n---\n\n${ATTACHED_HEADING} Application review\n\n## Verdict\n\nacceptable with conditions`);
  });
});
