import { describe, expect, test } from "bun:test";
import { answerText, choicesIn, segmentsIn } from "./choices.ts";

const TWO_QUESTIONS = [
  "## Unknowns",
  "",
  "- Default behavior for the bystander photo setting is unknown.",
  "",
  "## What I need from you",
  "",
  "What should the default be for the bystander photo setting, meaning what the app does when a saved photo appears to include another person?",
  "",
  "- Option: Allow saving if I choose to save",
  "- Option: Warn me before saving",
  "- Option: Block saving",
  "",
  "Which cloud recognition service should settings support first, because each service has different credentials, costs, and photo-retention terms?",
  "",
  "- Option: Pick a common service during the build",
  "- Option: Let me enter a custom service endpoint and API key",
  "- Option: I will name a specific service later",
].join("\n");

describe("segmentsIn", () => {
  test("a turn asking two questions, each with options, yields both as answerable, in order, with the prose kept", () => {
    const segments = segmentsIn(TWO_QUESTIONS);
    const questions = segments.filter((segment) => segment.kind === "question");
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ options: ["Allow saving if I choose to save", "Warn me before saving", "Block saving"] });
    expect(questions[0]!.kind === "question" && questions[0]!.question).toContain("bystander photo setting");
    expect(questions[1]).toMatchObject({ options: ["Pick a common service during the build", "Let me enter a custom service endpoint and API key", "I will name a specific service later"] });
    expect(segments[0]).toMatchObject({ kind: "text" });
    expect(segments[0]!.kind === "text" && segments[0]!.markdown).toContain("## What I need from you");
  });

  test("a list closed by the question is a question too", () => {
    const segments = segmentsIn(["Two approaches differ in ownership.", "", "1. Hosted service", "2. Self-managed deployment", "", "Which one?"].join("\n"));
    expect(segments).toEqual([
      { kind: "text", markdown: "Two approaches differ in ownership." },
      { kind: "question", question: "Which one?", options: ["Hosted service", "Self-managed deployment"] },
    ]);
  });

  test("a closing paragraph that only asks is a question without options; a bulleted digest is prose", () => {
    const segments = segmentsIn(["Here is the summary.", "", "- one thing", "- another thing", "", "Anything to change?"].join("\n"));
    expect(segments.at(-1)).toEqual({ kind: "question", question: "Anything to change?", options: [] });
    expect(segments.filter((segment) => segment.kind === "question")).toHaveLength(1);
  });

  test("choicesIn still reads the last question, unchanged", () => {
    expect(choicesIn(TWO_QUESTIONS)?.options).toEqual(["Pick a common service during the build", "Let me enter a custom service endpoint and API key", "I will name a specific service later"]);
  });
});

describe("answerText", () => {
  test("a lone question's option is sent exactly as offered", () => {
    expect(answerText("Which one?", "Hosted service", false)).toBe("Hosted service");
  });
  test("one of several is named for its question", () => {
    expect(answerText("What should the default be\nfor photos?", "Block saving", true)).toBe('On "What should the default be for photos?": Block saving');
  });
});
