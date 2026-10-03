import { describe, expect, test } from "bun:test";
import { composedMailFold, withoutSendBackRef } from "./composed-mail.ts";

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
});
