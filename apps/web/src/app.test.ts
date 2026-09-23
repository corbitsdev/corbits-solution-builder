import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "app.tsx"), "utf8");

describe("Settings can be left", () => {
  test("Settings shows a Back control", () => {
    expect(page).toContain('title="Back"');
    expect(page).toContain('aria-label="Back"');
  });

  test("the gear closes Settings when it is already open, rather than only opening it", () => {
    expect(page).toContain("inSettings ? (onSettingsClose ? onSettingsClose()");
  });

  test("Settings remembers where it was opened from", () => {
    expect(page).toContain("const [settingsFrom, setSettingsFrom]");
    expect(page).toContain("const closeSettings =");
  });
});
