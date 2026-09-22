import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;

function read(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

describe("mock radius tokens", () => {
  const mock = read("../../../mockups/mock.css");
  const styles = read("./styles.css");
  const home = read("./pages/home-layout.css");
  const onboarding = read("./pages/onboarding-layout.css");
  const settings = read("./pages/settings-layout.css");
  const workspace = read("./pages/workspace-layout.css");

  test("styles.css pins mock.css --radius-lg 10px and --radius-md 6px", () => {
    expect(mock).toMatch(/--radius-lg:\s*10px/);
    expect(mock).toMatch(/--radius-md:\s*6px/);
    expect(styles).toMatch(/--radius-lg:\s*10px/);
    expect(styles).toMatch(/--radius-md:\s*6px/);
    expect(styles).toContain("--radius-panel: var(--radius-lg)");
    expect(styles).toContain("--radius-control: var(--radius-md)");
  });

  test("cards, composer, and icon/send controls use the mock tokens", () => {
    expect(home).toContain(".home-page .composer-box");
    expect(home).toMatch(/\.home-page \.composer-box \{[\s\S]*border-radius: var\(--radius-lg\)/);
    expect(home).toMatch(/\.home-page \.card \{[\s\S]*border-radius: var\(--radius-lg\)/);
    expect(home).toMatch(/button\[aria-label="Send message"\][\s\S]*border-radius: var\(--radius-md\)/);
    expect(home).toMatch(/button\[aria-label="Attach files"\][\s\S]*border-radius: var\(--radius-md\)/);
    expect(home).toMatch(/\.dictate \{[\s\S]*border-radius: var\(--radius-md\)/);

    expect(workspace).toMatch(/\.composer \.composer-box \{[\s\S]*border-radius: var\(--radius-lg\)/);
    expect(workspace).toMatch(/button\[type="submit"\][\s\S]*border-radius: var\(--radius-md\)/);
    expect(workspace).toMatch(/\.composer \.dictate \{[\s\S]*border-radius: var\(--radius-md\)/);

    expect(onboarding).toMatch(/\.ob \.composer-box \{[\s\S]*border-radius: var\(--radius-lg\)/);
    expect(onboarding).toMatch(/button\[aria-label="Send message"\][\s\S]*border-radius: var\(--radius-md\)/);

    expect(settings).toMatch(/\.settings-page \.section-body \{[\s\S]*border-radius: var\(--radius-lg\)/);
    expect(styles).toMatch(/\.iconbtn \{[\s\S]*border-radius: var\(--radius-control\)/);
  });

  test("layout sheets do not fight the mock with 8px, 12px, or rounded-lg radii", () => {
    for (const css of [home, onboarding, settings, workspace]) {
      expect(css).not.toMatch(/border-radius:\s*8px/);
      expect(css).not.toMatch(/border-radius:\s*12px/);
      expect(css).not.toContain("rounded-lg");
      expect(css).not.toMatch(/var\(--radius-md,\s*6px\)/);
    }
  });

  test("seg-ctl inner buttons stay 4px and track segs stay 2px", () => {
    expect(settings).toMatch(/\.settings-page \.seg-ctl button \{[\s\S]*border-radius: 4px/);
    expect(onboarding).toMatch(/\.ob-frame \.seg-ctl button \{[\s\S]*border-radius: 4px/);
    expect(home).toMatch(/\.home-page \.card-track \.seg \{[\s\S]*border-radius: 2px/);
    expect(onboarding).toMatch(/\.ob-track \.seg \{[\s\S]*height: 2px/);
    expect(workspace).toMatch(/\.topbar-project \.stepper li > span,[\s\S]*border-radius: 2px/);
  });
});
