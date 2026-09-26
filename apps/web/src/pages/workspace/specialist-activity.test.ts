import { describe, expect, test } from "bun:test";
import { specialistActivity } from "./specialist-activity.ts";

// #113: the busy strip says which specialist is at work and what the stage
// asks of them.
describe("specialistActivity", () => {
  test("names the stage's specialist and its task", () => {
    expect(specialistActivity(4)).toBe("Experience designer is drawing the design");
    expect(specialistActivity(5)).toBe("Presentation creator is writing the stakeholder packages and their slides");
    expect(specialistActivity(8)).toBe("Build engineer is building the software");
  });

  test("a stage it does not know still says something true", () => {
    expect(specialistActivity(0)).toBe("The specialist is working on this stage");
  });
});
