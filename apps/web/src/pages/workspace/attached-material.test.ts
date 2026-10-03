import { describe, expect, test } from "bun:test";
import { composeMaterialMail, materialMarker, namedTogether, owedMaterial, splitMaterialMail } from "./attached-material.ts";
import type { ChainNode } from "./approved-chain.ts";
import { revisionRequest } from "@solutions-builder/app/stage-prompt";

const node = (over: Partial<ChainNode> & Pick<ChainNode, "id" | "kind">): ChainNode => ({
  title: over.id,
  artifactId: `art_${over.id}`,
  stage: 1,
  version: 1,
  variant: null,
  supersededByNodeId: null,
  createdAt: "2026-01-01T00:10:00.000Z",
  ...over,
});

const opening = { author: "me" as const, body: "Make leads easier.", at: "2026-01-01T00:05:00.000Z" };
const reply = { author: "agent" as const, body: "## In short\n- leads", at: "2026-01-01T00:06:00.000Z" };

describe("owedMaterial", () => {
  const reading = node({ id: "reading", kind: "material_reading", variant: "deck.pdf", mediaType: "text/plain" });
  const notes = node({ id: "notes", kind: "source_material", variant: "notes.md", mediaType: "text/markdown", createdAt: "2026-01-01T00:11:00.000Z" });

  test("a file attached after the stage's first mail is owed, oldest first: a text file as itself, any other as its reading", () => {
    const upload = node({ id: "upload", kind: "source_material", variant: "deck.pdf", mediaType: "application/pdf" });
    expect(owedMaterial({ nodes: [notes, upload, reading], messages: [opening, reply] }).map((entry) => entry.id)).toEqual(["reading", "notes"]);
  });

  test("a file that was there when the stage opened went in the opening, and is not owed", () => {
    const early = node({ id: "early", kind: "material_reading", variant: "brief.pdf", createdAt: "2026-01-01T00:01:00.000Z" });
    expect(owedMaterial({ nodes: [early], messages: [opening, reply] })).toEqual([]);
  });

  test("nothing is owed before the opening has gone: the opening carries the material", () => {
    expect(owedMaterial({ nodes: [reading, notes], messages: [] })).toEqual([]);
  });

  test("a file whose marker one of the person's mails carries is not owed again, however the mail was wrapped", () => {
    const mail = composeMaterialMail([{ node: { id: "reading", title: "deck.pdf (reading)", kind: "source_material", stage: 1 }, content: "Q3" }], 1);
    const sent = { author: "me" as const, body: revisionRequest({ stage: 1, userInput: mail, currentDocument: "## In short" }), at: "2026-01-01T00:12:00.000Z" };
    expect(owedMaterial({ nodes: [reading, notes], messages: [opening, reply, sent] }).map((entry) => entry.id)).toEqual(["notes"]);
  });

  test("a specialist echoing a marker does not make a file sent", () => {
    const echo = { author: "agent" as const, body: `Noted ${materialMarker("reading")}`, at: "2026-01-01T00:12:00.000Z" };
    expect(owedMaterial({ nodes: [reading], messages: [opening, echo] }).map((entry) => entry.id)).toEqual(["reading"]);
  });

  test("a stage that is sent back to is owed what was attached while the project was further on", () => {
    const later = node({ id: "later", kind: "material_reading", stage: 1, variant: "pricing.xlsx", createdAt: "2026-02-01T00:00:00.000Z" });
    expect(owedMaterial({ nodes: [later], messages: [opening, reply] }).map((entry) => entry.id)).toEqual(["later"]);
  });
});

describe("composeMaterialMail and splitMaterialMail", () => {
  const items = [
    { node: { id: "art_1", title: "notes.md", kind: "source_material", stage: 1 }, content: "Leads go cold in two days." },
    { node: { id: "art_2", title: "deck.pdf (reading)", kind: "source_material", stage: 1 }, content: "Page 1 of 1:\nQ3 pipeline" },
  ];

  test("the mail carries each file under its name, the way an opening does, and a marker for each", () => {
    const mail = composeMaterialMail(items, 1);
    expect(mail).toContain("--- MATERIAL THE PERSON PROVIDED: notes.md ---\nLeads go cold in two days.");
    expect(mail).toContain("--- MATERIAL THE PERSON PROVIDED: deck.pdf (reading) ---");
    expect(mail.endsWith("[material:art_1] [material:art_2]")).toBe(true);
  });

  test("the transcript reads back the files' names as the person attached them, and their text without the markers", () => {
    const split = splitMaterialMail(composeMaterialMail(items, 1));
    expect(split?.names).toEqual(["notes.md", "deck.pdf"]);
    expect(split?.material).toContain("Q3 pipeline");
    expect(split?.material).not.toContain("[material:");
  });

  test("a message that only quotes a material mail is not one", () => {
    expect(splitMaterialMail("an ordinary message")).toBeNull();
    expect(splitMaterialMail(`Here is what was said so far.\n\n${composeMaterialMail(items, 1)}`)).toBeNull();
  });

  test("names read as a sentence would list them", () => {
    expect(namedTogether([])).toBe("");
    expect(namedTogether(["a"])).toBe("a");
    expect(namedTogether(["a", "b"])).toBe("a and b");
    expect(namedTogether(["a", "b", "c"])).toBe("a, b and c");
  });
});
