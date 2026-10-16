import { describe, expect, test } from "bun:test";
import type { QuorumState } from "@solutions-builder/app/project-workflow/contracts";
import { ownProceedDecides } from "./own-proceed.ts";

const quorum = (over: Partial<QuorumState>): QuorumState => ({
  met: false,
  proceeded: 0,
  required: 1,
  blocked: [],
  missing: [],
  stale: [],
  ...over,
});

// #896: four stakeholders, quorum 1, nobody has decided. The person's own
// Proceed is the one still missing, so the gate's button must take it.
describe("ownProceedDecides", () => {
  test("the person's missing proceed meets a quorum of one among others", () => {
    expect(ownProceedDecides(quorum({ missing: ["You", "Dick Head", "Grey Beard", "Mr. Moneybags"] }), "You")).toBe(true);
  });

  test("their proceed completes a larger quorum one short", () => {
    expect(ownProceedDecides(quorum({ required: 2, proceeded: 1, missing: ["You", "Grey Beard"] }), "You")).toBe(true);
  });

  test("their proceed on an earlier package counts as still owed", () => {
    expect(ownProceedDecides(quorum({ stale: ["You"], missing: ["Grey Beard"] }), "You")).toBe(true);
  });

  test("held while others' proceeds are still needed", () => {
    expect(ownProceedDecides(quorum({ required: 2, missing: ["You", "Grey Beard"] }), "You")).toBe(false);
  });

  test("held when the person has already proceeded", () => {
    expect(ownProceedDecides(quorum({ required: 2, proceeded: 1, missing: ["Grey Beard"] }), "You")).toBe(false);
  });

  test("never overrides a block, the person's own included", () => {
    expect(ownProceedDecides(quorum({ blocked: ["Grey Beard"], missing: ["You"] }), "You")).toBe(false);
    expect(ownProceedDecides(quorum({ blocked: ["You"] }), "You")).toBe(false);
  });

  test("held when the person is not a stakeholder, or not on the review's roster", () => {
    expect(ownProceedDecides(quorum({ missing: ["Grey Beard"] }), null)).toBe(false);
    expect(ownProceedDecides(quorum({ missing: ["Grey Beard"] }), "You")).toBe(false);
  });

  test("nothing to record once the quorum is met, or before a review opens", () => {
    expect(ownProceedDecides(quorum({ met: true, proceeded: 1, missing: ["You"] }), "You")).toBe(false);
    expect(ownProceedDecides(null, "You")).toBe(false);
  });
});
