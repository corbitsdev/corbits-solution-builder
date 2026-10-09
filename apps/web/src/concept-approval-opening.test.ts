import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conceptApprovalLead, conceptApprovalOpening, rosterOnRecordLine } from "./concept-approval-opening.ts";
import { HANDOFF_LEAD, splitHandoff } from "./design-handoff.ts";

const roster = { audiences: [{ name: "You", role: "project_owner" }, { name: "Brent Mattson", role: "budget_approver" }], quorum: 2 };
const solo = { audiences: [{ name: "You", role: "project_owner" }], quorum: 1 };

// #722: the Presentation creator's prompt expects every request to name a
// reader, so an opening that was only the design read as a request and the
// first reply announced a package it never wrote.
describe("conceptApprovalOpening", () => {
  test("leads with what is opening, who is on record, and that no package is asked for yet", () => {
    const lead = conceptApprovalLead(roster);
    expect(lead).toStartWith("Concept approval is opening on the approved GUI design below.");
    expect(lead).toContain("On record so far: You (project owner), Brent Mattson (budget approver); 2 of them must proceed.");
    expect(lead).toContain("No package is requested yet");
    expect(lead).toContain("find out who needs to approve to move forward");
    expect(lead).toContain("Packages come after");
  });

  test("names a sole stakeholder and the quorum as the policy holds them", () => {
    expect(rosterOnRecordLine(solo)).toBe("On record so far: You (project owner); 1 of them must proceed.");
    expect(rosterOnRecordLine({ audiences: [], quorum: 0 })).toBe("No stakeholders are on record yet.");
    expect(rosterOnRecordLine({ ...roster, quorum: 0 })).toContain("each decides for themselves");
  });

  test("carries a Markdown design as it is, after the lead", () => {
    const body = conceptApprovalOpening("## Design\n\nThree tabs.", solo);
    expect(body).toBe(`${conceptApprovalLead(solo)}\n\n## Design\n\nThree tabs.`);
  });

  // #219: an HTML mockup goes over as its text; #301: the transcript folds
  // it behind the lead, so the lead must sit before the hand-off's own line.
  test("carries an HTML design as its text, folded by the transcript under the lead", () => {
    const body = conceptApprovalOpening("<!doctype html><html><head><title>Mockup</title></head><body><h2>Phone</h2><p>Three tabs.</p></body></html>", solo);
    expect(body).not.toContain("<h2>");
    expect(body).toContain("```text\n# Mockup\n\n## Phone\n\nThree tabs.\n```");
    const split = splitHandoff(body);
    expect(split?.lead).toBe(conceptApprovalLead(solo));
    expect(split?.attached.startsWith(HANDOFF_LEAD)).toBe(true);
  });
});

// Both routes into Concept approval compose the one opening (#418): in
// session off the approved review, on reload off the approved artifact.
describe("the two openings never drift", () => {
  const decisions = readFileSync(join(import.meta.dir, "pages/workspace/use-stage-decisions.ts"), "utf8");
  const dispatch = readFileSync(join(import.meta.dir, "pages/workspace/use-opening-dispatch.ts"), "utf8");

  test("the in-session hand-off and the reload path both call conceptApprovalOpening with the policy's roster", () => {
    expect(decisions).toContain("conceptApprovalOpening(reviewMessage.body, rosterOf(detail.project.policy))");
    expect(dispatch).toContain("stage === 5 ? conceptApprovalOpening(result.content, rosterOf(detail.project.policy)) : result.content");
    expect(decisions).not.toContain("designHandoff(");
    expect(dispatch).not.toContain("designHandoff(");
  });
});
