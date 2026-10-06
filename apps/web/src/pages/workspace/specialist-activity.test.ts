import { describe, expect, test } from "bun:test";
import { specialistActivity } from "./specialist-activity.ts";

// #113: the busy strip says which specialist is at work and what the stage
// asks of them.
describe("specialistActivity", () => {
  test("names the stage's specialist and its task", () => {
    expect(specialistActivity(4)).toBe("Experience designer is drawing the design");
    expect(specialistActivity(5)).toBe("Presentation creator is writing the stakeholder packages and their slides");
    expect(specialistActivity(8)).toBe("Build supervisor is reviewing the build");
  });

  test("a stage it does not know still says something true", () => {
    expect(specialistActivity(0)).toBe("The specialist is working on this stage");
  });
});

// #407: the line follows the ask, not only the stage.
describe("specialistActivity by ask", () => {
  test("a question is answered, a change is a redraft, a first draft is the stage's task", () => {
    expect(specialistActivity(6, "question")).toBe("Architect is answering");
    expect(specialistActivity(6, "redraft")).toBe("Architect is redrafting the build plan");
    expect(specialistActivity(6, "draft")).toBe("Architect is writing the build plan");
    expect(specialistActivity(6)).toBe("Architect is writing the build plan");
  });
});

// #768: a brief to the Build supervisor is answered with a status, not a draft.
describe("specialistActivity for the Build supervisor", () => {
  test("a brief is a status being written; a change asked of it redrafts the status", () => {
    expect(specialistActivity(8, "status")).toBe("Build supervisor is writing the build status");
    expect(specialistActivity(8, "redraft")).toBe("Build supervisor is redrafting the build status");
  });
});
