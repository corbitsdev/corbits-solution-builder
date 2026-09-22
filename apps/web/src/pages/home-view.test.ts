import { describe, expect, test } from "bun:test";
import {
  HOME_COMPOSER_PLACEHOLDER,
  HOME_EMPTY_DESCRIPTION,
  HOME_EMPTY_TITLE,
  HOME_NEEDS_DECISION,
  canStartProject,
  cardFootStage,
  stageTrackSegClass,
} from "./home-view.ts";

describe("canStartProject", () => {
  test("the create gate is ten characters, silent", () => {
    expect(canStartProject("")).toBe(false);
    expect(canStartProject("short")).toBe(false);
    expect(canStartProject("123456789")).toBe(false);
    expect(canStartProject("1234567890")).toBe(true);
    expect(canStartProject("  1234567890  ")).toBe(true);
  });
});

describe("home copy", () => {
  test("composer and empty card match the mockup", () => {
    expect(HOME_COMPOSER_PLACEHOLDER).toBe("Describe the thing you want built…");
    expect(HOME_EMPTY_TITLE).toBe("Nothing yet");
    expect(HOME_EMPTY_DESCRIPTION).toBe("Describe the thing above — the discovery stage starts there.");
    expect(HOME_NEEDS_DECISION).toBe("Needs decision");
  });
});

describe("stageTrackSegClass", () => {
  test("nine segments: prior done, current now, rest empty", () => {
    const segs = Array.from({ length: 9 }, (_, i) => stageTrackSegClass(i + 1, 3, false));
    expect(segs).toEqual(["seg done", "seg done", "seg now", "seg", "seg", "seg", "seg", "seg", "seg"]);
  });

  test("a delivered project fills through the current stage", () => {
    const segs = Array.from({ length: 9 }, (_, i) => stageTrackSegClass(i + 1, 9, true));
    expect(segs.every((cls) => cls === "seg done")).toBe(true);
  });

  test("an unread workflow does not invent a current segment", () => {
    expect(stageTrackSegClass(1, null, false)).toBe("seg");
  });
});

describe("cardFootStage", () => {
  test("names the live stage, delivered, or a failed read — never a fake time", () => {
    expect(cardFootStage(1, false, false)).toBe("Problem discovery");
    expect(cardFootStage(9, true, false)).toBe("Delivered");
    expect(cardFootStage(4, false, true)).toBe("Status unavailable");
    expect(cardFootStage(null, false, false)).toBe("Not started");
  });
});
