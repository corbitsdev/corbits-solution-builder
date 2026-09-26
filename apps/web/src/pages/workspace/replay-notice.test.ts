import { describe, expect, test } from "bun:test";
import { describeReplay } from "./replay-notice.ts";

const FROM = { deploymentId: "dep_old", runId: "run_old", tenantId: "proj_1" };

describe("describeReplay", () => {
  test("no replay, or one that refused nothing, needs no notice", () => {
    expect(describeReplay(undefined)).toBeNull();
    expect(describeReplay({ from: FROM, replayed: 3, refused: [] })).toBeNull();
  });

  test("names each refused decision with the workflow's own reason, and says the project stands where the new rules put it", () => {
    const notice = describeReplay({
      from: FROM,
      replayed: 4,
      refused: [{ decisionId: "dec-1", kind: "approve", stage: 5, reason: "quorum_not_met" }],
    });
    expect(notice?.title).toBe("This project's workflow was updated, and one earlier decision no longer holds under the new rules.");
    expect(notice?.detail).toBe(
      "The project stands where the updated rules put it. The approval at Concept approval was refused: The stakeholder quorum has not been met yet. Take any of these again if it is still wanted.",
    );
  });

  test("counts several refusals and falls back to plain words for an unknown kind or reason", () => {
    const notice = describeReplay({
      from: FROM,
      replayed: 2,
      refused: [
        { decisionId: "dec-1", kind: "audience", stage: 5, reason: "unknown_audience" },
        { decisionId: "dec-2", kind: null, stage: null, reason: "something_new" },
      ],
    });
    expect(notice?.title).toBe("This project's workflow was updated, and 2 earlier decisions no longer hold under the new rules.");
    expect(notice?.detail).toContain("The stakeholder decision at Concept approval was refused: ");
    expect(notice?.detail).toContain("The decision was refused: something_new.");
  });
});
