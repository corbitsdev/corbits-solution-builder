import { describe, expect, test } from "bun:test";
import { keepUntilInstalled, shouldShowOnboarding } from "./onboarding-gate.ts";

describe("shouldShowOnboarding", () => {
  test("no provider ready always onboards; an empty list onboards only outside a project and before skipping", () => {
    expect(shouldShowOnboarding({ inferenceConnected: false, projectCount: 3, skippedSetup: true, inProject: true })).toBe(true);
    expect(shouldShowOnboarding({ inferenceConnected: true, projectCount: 0, skippedSetup: false, inProject: false })).toBe(true);
    expect(shouldShowOnboarding({ inferenceConnected: true, projectCount: 0, skippedSetup: true, inProject: false })).toBe(false);
    expect(shouldShowOnboarding({ inferenceConnected: true, projectCount: 2, skippedSetup: false, inProject: false })).toBe(false);
    // #754: an open project is never left for the first-project step.
    expect(shouldShowOnboarding({ inferenceConnected: true, projectCount: 0, skippedSetup: false, inProject: true })).toBe(false);
  });
});

describe("keepUntilInstalled", () => {
  test("an install conflict keeps what is held; anything else is rethrown", () => {
    const install = { install: true };
    expect(keepUntilInstalled(install, (cause) => cause === install)).toBeNull();
    expect(() => keepUntilInstalled(new Error("down"), () => false)).toThrow("down");
  });
});
