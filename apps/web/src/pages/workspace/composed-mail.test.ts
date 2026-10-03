import { describe, expect, test } from "bun:test";
import { composedMailFold, withoutSendBackRef, isStageOpening } from "./composed-mail.ts";
import { composeMaterialMail } from "./attached-material.ts";
import { revisionRequest } from "@solutions-builder/app/stage-prompt";

describe("composedMailFold", () => {
  test("a person's own message is never folded", () => {
    expect(composedMailFold({ author: "me", body: "Make the brief shorter." })).toBeNull();
    expect(composedMailFold({ author: "agent", body: "[ref:dec_1] echoed", subject: "[opening:p:3] x" })).toBeNull();
  });

  test("an opening folds behind one line naming its stage", () => {
    const fold = composedMailFold({ author: "me", subject: "[opening:proj_1:9] Deliver", body: "Manifest node id: art_1@1\n- a.ts — sha256 abc" });
    expect(fold).toEqual({ summary: "What Deliver opened with", body: "Manifest node id: art_1@1\n- a.ts — sha256 abc", lead: null });
  });

  test("a send-back cue shows its sentence and never its marker", () => {
    const fold = composedMailFold({ author: "me", body: "This stage was sent back: tighten it. Address it and send the whole document again as a new draft. [ref:dec_42]" });
    expect(fold).toEqual({ summary: null, body: "", lead: "This stage was sent back: tighten it. Address it and send the whole document again as a new draft." });
    expect(withoutSendBackRef("plain")).toBe("plain");
  });

  test("a requirement-ids block folds and the ask beside it stays visible", () => {
    const body = "## Requirements (authoritative ids)\n\n- FR-1: Does a thing.\n- AC-1: It is checked.\n\nReview the plan's application concerns.";
    const fold = composedMailFold({ author: "me", body });
    expect(fold?.summary).toBe("The requirement ids, as minted");
    expect(fold?.body).toBe("## Requirements (authoritative ids)\n\n- FR-1: Does a thing.\n- AC-1: It is checked.");
    expect(fold?.lead).toBe("Review the plan's application concerns.");
  });

  test("a stage 6 send-back cue folds its ids and shows the cue without the marker", () => {
    const body = "## Requirements (authoritative ids)\n\n- FR-1: Does a thing.\n\nThis stage was sent back: add auth. Address it and send the whole document again as a new draft. [ref:dec_7]";
    const fold = composedMailFold({ author: "me", body });
    expect(fold?.body).toBe("## Requirements (authoritative ids)\n\n- FR-1: Does a thing.");
    expect(fold?.lead).toBe("This stage was sent back: add auth. Address it and send the whole document again as a new draft.");
  });

  test("material attached after the opening shows the files' names and folds what they say, with or without a draft to revise", () => {
    const mail = composeMaterialMail(
      [
        { node: { id: "art_1", title: "notes.md", kind: "source_material", stage: 1 }, content: "Leads go cold in two days." },
        { node: { id: "art_2", title: "deck.pdf (reading)", kind: "source_material", stage: 1 }, content: "Page 1 of 1:\nQ3 pipeline" },
      ],
      1,
    );
    for (const body of [mail, revisionRequest({ stage: 1, userInput: mail, currentDocument: "## In short\n- leads" })]) {
      const fold = composedMailFold({ author: "me", body });
      expect(fold?.lead).toBe("Attached notes.md and deck.pdf.");
      expect(fold?.summary).toBe("What the attached material says");
      expect(fold?.body).toContain("Leads go cold in two days.");
      expect(fold?.body).not.toContain("[material:");
    }
    expect(composedMailFold({ author: "agent", body: mail })).toBeNull();
  });
});

describe("isStageOpening", () => {
  test("only the app's opening mail counts, never a person's or a specialist's", () => {
    expect(isStageOpening({ author: "me", subject: "[opening:prj_1:4] GUI design" })).toBe(true);
    expect(isStageOpening({ author: "me", subject: "[opening:prj_1:1] Problem discovery" })).toBe(false);
    expect(isStageOpening({ author: "me", subject: "Re: the brief" })).toBe(false);
    expect(isStageOpening({ author: "me" })).toBe(false);
    expect(isStageOpening({ author: "agent", subject: "[opening:prj_1:4] GUI design" })).toBe(false);
  });
});
