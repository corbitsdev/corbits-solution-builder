import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSER_BOX_CLASS,
  CONV_CLASS,
  CONV_SCROLL_CLASS,
  PANES_CLASS,
  STAGE_PANE_CLASS,
} from "./pane-classes.ts";

const here = import.meta.dir;

function read(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

describe("project chrome classes", () => {
  test("pane classes carry the mock names beside the existing layout classes", () => {
    expect(PANES_CLASS).toBe("panes document-layout");
    expect(CONV_CLASS).toBe("conv stage-thread");
    expect(STAGE_PANE_CLASS).toBe("stage-pane document");
    expect(CONV_SCROLL_CLASS).toBe("conv-scroll thread-turns");
    expect(COMPOSER_BOX_CLASS).toBe("composer-box");
  });

  test("the layout sheet pins 420px conversation, conv-scroll, and composer-box", () => {
    const css = read("../workspace-layout.css");
    expect(css).toContain("grid-template-columns: 420px minmax(0, 1fr)");
    expect(css).toContain(".conv-scroll");
    expect(css).toContain(".composer .composer-box");
    expect(css).toContain(".topbar.topbar-project");
    expect(css).toContain("flex-direction: column");
  });

  test("the project topbar toggle is project-view only", () => {
    const app = read("../../app.tsx");
    expect(app).toContain('inProject ? "topbar topbar-project" : "topbar"');
    expect(app).toContain('className="stepper"');
  });

  test("workspace.tsx loads the layout sheet", () => {
    expect(read("../workspace.tsx")).toContain('import "./workspace-layout.css"');
  });
});
