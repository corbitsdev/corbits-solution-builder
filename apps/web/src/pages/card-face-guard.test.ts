import { describe, expect, test } from "bun:test";
import { FACE_SETTLE_MS, faceOpensProject } from "./card-face-guard.ts";

const idle = { menuOpen: false, dialogOpen: false, dismissingClick: false, closedAt: null, now: 1000 };

describe("faceOpensProject", () => {
  test("an idle card opens on its face", () => {
    expect(faceOpensProject(idle)).toBe(true);
  });
  test("nothing on the face opens the project while its menu or info dialog is open", () => {
    expect(faceOpensProject({ ...idle, menuOpen: true })).toBe(false);
    expect(faceOpensProject({ ...idle, dialogOpen: true })).toBe(false);
  });
  test("the click produced by the press that dismissed the menu never opens the project, however late it arrives", () => {
    expect(faceOpensProject({ ...idle, dismissingClick: true, closedAt: 0, now: 5000 })).toBe(false);
  });
  test("a double-click's second click, landing just after the menu closed, does not open the project", () => {
    expect(faceOpensProject({ ...idle, closedAt: 1000, now: 1000 + FACE_SETTLE_MS - 1 })).toBe(false);
  });
  test("once the menu is done and settled the face is back to normal", () => {
    expect(faceOpensProject({ ...idle, closedAt: 1000, now: 1000 + FACE_SETTLE_MS })).toBe(true);
  });
});
