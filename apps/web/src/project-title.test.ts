import { describe, expect, test } from "bun:test";
import { titleFromProblem, titleFromReply } from "./client.ts";

describe("titleFromProblem", () => {
  test("takes the first clause, about five words", () => {
    expect(titleFromProblem("Our invoices are reconciled by hand every month. It takes days.")).toBe("Our invoices are reconciled by");
  });

  test("skips links rather than returning one", () => {
    expect(titleFromProblem("https://github.com/acme/repo needs a release pipeline")).toBe("needs a release pipeline");
    expect(titleFromProblem("See www.example.com for the spec")).toBe("See for the spec");
  });

  test("is Untitled project when nothing but a link is left", () => {
    expect(titleFromProblem("https://github.com/acme/repo")).toBe("Untitled project");
    expect(titleFromProblem("   ")).toBe("Untitled project");
  });
});

describe("titleFromReply", () => {
  test("strips quotes, a label and trailing punctuation", () => {
    expect(titleFromReply('"Veterinary Appointment Reminder System."')).toBe("Veterinary Appointment Reminder System");
    expect(titleFromReply("Title: Bakery Custom Order Tracker\n\nThis names the project.")).toBe("Bakery Custom Order Tracker");
  });

  test("is null outside three to eight words", () => {
    expect(titleFromReply("Untitled Project")).toBeNull();
    expect(titleFromReply("A Very Long Title That Goes On For Far Too Many Words")).toBeNull();
    expect(titleFromReply("   ")).toBeNull();
  });
});
