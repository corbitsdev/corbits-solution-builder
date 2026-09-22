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
    expect(read("../workspace.tsx")).toContain('import "./workspace/stage-chrome.css"');
  });
});

describe("project chrome paint", () => {
  const css = read("../workspace-layout.css");
  const global = read("../../styles.css");

  test("composer is stacked box/foot with ink send and destructive stop", () => {
    expect(css).toContain(".composer .composer-foot");
    expect(css).toContain('[data-slot="chat-input-footer"]');
    expect(css).toContain('[data-slot="chat-input-body"] textarea');
    expect(css).toMatch(/button\[type="submit"\][\s\S]*background: var\(--wb-foreground\)/);
    expect(css).toMatch(/button\[aria-label="Stop generating"\][\s\S]*background: var\(--wb-destructive\)/);
    expect(css).toContain(".composer .dictate");
  });

  test("stepper: done is ink, now is primary, future is faded, hover is muted never primary", () => {
    expect(css).toContain(".topbar-project .stepper li > button {\n  background: var(--wb-foreground);");
    expect(css).toContain('.topbar-project .stepper li[aria-current="step"] > span');
    expect(css).toContain("background: var(--wb-primary);");
    expect(css).toContain(".topbar-project .stepper li:not([aria-current=\"step\"]) > span {\n  opacity: 0.5;");
    expect(css).toContain(".topbar-project .stepper li > button:hover {\n  background: var(--wb-muted-foreground);");
    expect(css).not.toContain("button:hover {\n  background: var(--wb-primary)");
  });

  test("artifact strip: ghost tabs, selected is pane paper, live is a primary dot", () => {
    expect(css).toContain('.artifact-strip-tabs [role="tab"] {');
    expect(css).toContain("background: transparent;");
    expect(css).toContain('.artifact-strip-tabs [role="tab"][aria-selected="true"]');
    expect(css).toContain("background: var(--card);");
    expect(css).toContain(".artifact-strip-live");
    expect(css).toContain("background: var(--wb-primary);");
  });

  test("approve stays quiet; is-ready is not a filled green pill", () => {
    expect(css).toContain(".composer-approve .is-ready button");
    expect(css).not.toContain("color-mix(in srgb, var(--ok, var(--wb-okay)) 12%");
    const ready = global.slice(
      global.indexOf(".composer-approve .is-ready button {"),
      global.indexOf(".composer-request"),
    );
    expect(ready).toContain("background: transparent;");
    expect(ready).not.toContain("var(--wb-okay)");
  });

  test("narrow stacks at 900px with conversation first — no order swap", () => {
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).not.toContain("@media (max-width: 1080px)");
    const start = css.indexOf("@media (max-width: 900px)");
    const end = css.indexOf("}", css.indexOf(".conv {", start)) + 1;
    const narrow = css.slice(start, end);
    expect(narrow).toContain("grid-template-rows: 1fr 1fr");
    expect(narrow).not.toMatch(/(^|\n)\s*order:/);
  });

  test("send-back popover uses --popover, not --wb-card", () => {
    expect(css).toContain(".sbpick {\n  background: var(--popover);");
    const sbpick = global.slice(global.indexOf(".sbpick {"), global.indexOf(".sbpick-head"));
    expect(sbpick).toContain("background: var(--popover);");
    expect(sbpick).not.toContain("--wb-card");
  });

  test("the conversation composer slots the Dictated mic into ChatInput leadingTools", () => {
    const thread = read("./thread.tsx");
    expect(thread).toContain("<Dictated");
    expect(thread).toContain("ChatInput");
    expect(thread).toContain("leadingTools={mic}");
    expect(thread).toContain("attachIcon");
    expect(thread).toContain("sendIcon");
  });

  test("StagePanes is the shell for document, build, waiting, and specialised stages", () => {
    expect(read("./document.tsx")).toContain("<StagePanes");
    expect(read("./build.tsx")).toContain("<StagePanes");
    const index = read("./index.tsx");
    expect(index).toContain("<StagePanes");
    expect(index).toContain("DOCUMENT_STAGES.has(stage) && !draftMessage");
    expect(index).toContain("stage === 4");
    expect(index).toContain("stage === 5");
    expect(index).toContain("stage === 9");
  });

  test("project canvas is panes only — no Stage extras fold, no wait essay", () => {
    const index = read("./index.tsx");
    expect(index).not.toContain("<GuidanceFold");
    expect(index).not.toContain("<WaitingSection");
    expect(index).not.toContain("<GuidanceCard");
    expect(index).toContain("onSendHold");
    expect(index).toContain("<StagePanes");
    const app = read("../../app.tsx");
    expect(app).not.toContain("GuideDock");
    expect(app).not.toContain("head-tabs");
    expect(app).toContain("<StageWorkspace");
    expect(app).not.toContain("ThemeToggle");
    expect(app).not.toContain("PanelRight");
    expect(app).not.toContain("Hide the draft");
    const layout = read("../workspace-layout.css");
    expect(layout).toMatch(/\.stage-pane \{[\s\S]*background: var\(--wb-background\)/);
  });

  test("the chat shows a short lead for substantial drafts — the document pane has the rest", () => {
    expect(read("./thread.tsx")).toContain("conversationLead");
  });

  test("opening the project uses the two-pane chrome, not a progress essay", () => {
    const chrome = read("./workspace-chrome.tsx");
    expect(chrome).toContain("export function OpeningScreen");
    expect(chrome).not.toContain("Opening the project");
    expect(chrome).not.toContain("Getting the conversation ready");
    expect(chrome).toContain("Opening…");
    expect(chrome).toContain("<StagePanes");
    const index = read("./index.tsx");
    expect(index).not.toContain("Starting the");
    expect(index).toContain("<OpeningScreen");
  });

  test("stage 8 right pane is a document, not a dashboard", () => {
    const build = read("./build.tsx");
    expect(build).toContain('className="doc"');
    expect(build).toContain('className="docmeta"');
    expect(build).toContain('className="ev"');
    expect(build).toContain("Build Evidence");
    expect(build).toContain("Start the build attempt");
    expect(build).toContain("Accept as evidence");
    expect(build).not.toContain("Build supervision");
    expect(build).not.toContain("<Screen");
    expect(build).not.toContain("Starting the build specialist");
    expect(build).not.toContain("elapsed since the build attempt started");
    expect(build).not.toContain("A command's output is never recorded");
    expect(build).not.toContain("No build activity has reported yet");
    expect(build).not.toContain("<GuidanceFold");
    expect(build).not.toContain("<WaitingSection");
    const css = read("../workspace-layout.css");
    expect(css).toContain(".ev {");
    expect(css).toContain(".ev .p {");
    expect(css).toContain(".ev .f {");
  });
});
