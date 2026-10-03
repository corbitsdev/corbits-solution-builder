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

  test("stage 6's companion scrolls its open document inside the window (#330)", () => {
    const css = read("../../styles.css");
    expect(css).toMatch(/^\.stage6-companion \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*min-height: 0;/m);
    expect(css).toMatch(/^\.stage6-companion \.document-fold \{[^}]*min-height: 0;[^}]*overflow-y: auto;/m);
  });

  test("the log never scrolls sideways, and each turn is held to the column (#321)", () => {
    const css = read("../workspace-layout.css");
    expect(css).toMatch(/^\.conv-scroll \{[^}]*overflow-x: hidden;/m);
    expect(css).toMatch(/\.conv-scroll > \* \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  });

  test("a message never grows past the column for a wide code block; the block scrolls inside the bubble (#317)", () => {
    const css = read("../workspace-layout.css");
    const msg = css.slice(css.indexOf(".conv .msg {"), css.indexOf("}", css.indexOf(".conv .msg {")));
    expect(msg).toContain("min-width: 0;");
    const bubble = css.slice(css.indexOf(".conv .msg .bubble {"), css.indexOf("}", css.indexOf(".conv .msg .bubble {")));
    expect(bubble).toContain("min-width: 0;");
    expect(bubble).toContain("max-width: 100%;");
    expect(bubble).toContain("overflow-wrap: anywhere;");
    expect(css).toMatch(/\.conv \.msg \.bubble pre \{[^}]*overflow-x: auto;/);
  });

  test("the layout sheet gives the conversation a proportional, resizable column with a 420px floor, conv-scroll, and composer-box", () => {
    const css = read("../workspace-layout.css");
    expect(css).toContain("grid-template-columns: minmax(320px, min(var(--panes-chat-w, min(40%, 640px)), calc(100% - 360px))) minmax(0, 1fr)");
    // #343: the grid never outgrows the canvas, whatever the splitter stored.
    expect(css).toMatch(/^\.panes > \* \{[^}]*min-width: 0;/m);
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

describe("stage 7 lead cards", () => {
  const global = read("../../styles.css");

  test("the target question and estimate summary are cards on the conversation's gutter, not bare text", () => {
    expect(read("./freeze.tsx")).toContain('className="stage-lead target-picker"');
    expect(read("./estimate.tsx")).toContain('className="stage-lead estimate-view"');
    expect(global).toMatch(
      /\.stage-view > \.stage-lead \{[^}]*margin: var\(--space-4\) var\(--space-5\) 0;[^}]*border: 1px solid var\(--wb-border\);[^}]*border-radius: var\(--radius-lg\);[^}]*background: var\(--wb-card\);/,
    );
    // The gutter is the one `.conv-scroll` gives the turns beneath the card.
    expect(read("../workspace-layout.css")).toMatch(/\.conv-scroll \{[^}]*padding: var\(--space-5\);/);
  });
});

describe("project chrome paint", () => {
  const css = read("../workspace-layout.css");
  const global = read("../../styles.css");

  test("conversation turns are mock msg/bubble with ink send, not library cards", () => {
    const thread = read("./thread.tsx");
    expect(thread).toContain('className={you ? "msg you" : "msg"}');
    expect(thread).toContain('className="bubble"');
    expect(thread).not.toContain("ChatThread");
    expect(css).toContain(".conv .msg {");
    expect(css).toContain(".conv .msg.you {");
    expect(css).toContain(".conv .msg .bubble {");
    expect(css).toContain(".composer .sendbtn");
    expect(css).toMatch(/\.composer \.sendbtn,[\s\S]*?background: var\(--wb-foreground\)/);
  });

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

  test("a done stage opened from the track is ringed as the one being viewed, and named as such beneath the track", () => {
    expect(css).toMatch(/\.topbar-project \.stepper li\[data-viewed\] > button,\n\.topbar-project \.stepper li\[data-viewed\] > span \{[^}]*outline: 2px solid var\(--wb-primary\);/);
    const app = read("../../app.tsx");
    expect(app).toContain('{ "data-viewed": "" }');
    expect(app).toContain("· viewing · at ");
    const workspace = read("./index.tsx");
    expect(workspace).toContain("onViewedStage?.(viewedStage)");
    // #116: the stage by its name, never its number.
    expect(workspace).toContain("Change it: send back to {stageName(artifacts.activeNode.stage)}…");
    expect(workspace).toContain("Back to {stageName(stage)}");
  });

  test("a pointer under the current segment marks where you are", () => {
    expect(css).toMatch(/\.topbar-project \.stepper li\[aria-current="step"\]::after \{[^}]*border-bottom: 4px solid var\(--wb-primary\);/);
    expect(css).toMatch(/\.topbar-project \.stepper li\[aria-current="step"\] \{[^}]*position: relative;/);
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

  test("the splitter gets its own grid track — StagePanes renders it as a third child", () => {
    expect(css).toContain(
      ".panes:has(> .panes-splitter) {\n  grid-template-columns: minmax(320px, min(var(--panes-chat-w, min(40%, 640px)), calc(100% - 360px))) auto minmax(0, 1fr);",
    );
  });

  test("narrow stacks at 900px with conversation first — no order swap", () => {
    expect(css).toContain("@media (max-width: 900px)");
    expect(css).not.toContain("@media (max-width: 1080px)");
    const start = css.indexOf("@media (max-width: 900px)");
    const end = css.indexOf("}", css.indexOf(".conv {", start)) + 1;
    const narrow = css.slice(start, end);
    expect(narrow).toContain("grid-template-rows: 1fr 1fr");
    expect(narrow).toContain(".panes:has(> .panes-splitter)");
    expect(narrow).not.toMatch(/(^|\n)\s*order:/);
  });

  test("send-back popover uses --popover, not --wb-card", () => {
    expect(css).toContain(".sbpick {\n  background: var(--popover);");
    const sbpick = global.slice(global.indexOf(".sbpick {"), global.indexOf(".sbpick-head"));
    expect(sbpick).toContain("background: var(--popover);");
    expect(sbpick).not.toContain("--wb-card");
  });

  test("the conversation composer slots the attach menu and the Dictated mic into ChatInput leadingTools", () => {
    const thread = read("./thread.tsx");
    expect(thread).toContain("<Dictated");
    expect(thread).toContain("ChatInput");
    expect(thread).toContain("leadingTools={");
    expect(thread).toContain("<AttachMenu");
    expect(thread).toContain("{mic}");
    expect(thread).toContain("sendIcon");
  });

  test("StagePanes is the shell for document, build, waiting, and specialised stages", () => {
    expect(read("./document.tsx")).toContain("<StagePanes");
    expect(read("./build.tsx")).toContain("<StagePanes");
    const index = read("./index.tsx");
    expect(index).toContain("<StagePanes");
    expect(index).toContain("DOCUMENT_STAGES.has(stage)");
    expect(index).toContain("!draftMessage");
    expect(index).toContain("stage === 4");
    expect(index).toContain("stage === 5");
    expect(index).toContain("stage === 6");
    expect(index).toContain("stage === 9");
    expect(read("./stage6.tsx")).toContain("<StagePanes");
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

  test("opening the project uses the two-pane chrome, not a progress essay, and never a timer", () => {
    const chrome = read("./workspace-chrome.tsx");
    expect(chrome).toContain("export function OpeningScreen");
    expect(chrome).not.toContain("Opening the project");
    expect(chrome).not.toContain("Getting the conversation ready");
    expect(chrome).not.toContain("useElapsedMs");
    expect(chrome).not.toContain("elapsed-clock");
    expect(chrome).toContain("Reconnecting to the");
    expect(chrome).toContain("is getting ready…");
    expect(chrome).toContain("<StagePanes");
    expect(chrome).toContain("opening-stage-name");
    expect(chrome).toContain("<ChatInput");
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
    expect(build).toContain("Record attempt");
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

  test("stage 6 right pane is a document, not a notes wall", () => {
    const stage6 = read("./stage6.tsx");
    expect(stage6).toContain('className="stage-inner"');
    expect(stage6).toContain('className="doc"');
    expect(stage6).toContain('className="docmeta"');
    expect(stage6).toContain("<StagePanes");
    expect(stage6).toContain("ensureStage6RoleAgent");
    expect(stage6).toContain("Request review");
    expect(stage6).not.toContain("stage-companions");
    expect(stage6).not.toContain("stage6-panel-cards");
    expect(stage6).not.toContain("<Screen");
    expect(stage6).not.toContain("<GuidanceFold");
    expect(stage6).not.toContain("<WaitingSection");
    const index = read("./index.tsx");
    expect(index).toContain("<Stage6Panel");
    expect(index).not.toContain("stage-companions");
    expect(index).not.toContain("stage6-panel-cards");
  });

  test("stage 9 right pane is a document, not a decision card", () => {
    const delivery = read("./delivery.tsx");
    expect(delivery).toContain('className="doc"');
    expect(delivery).toContain('className="docmeta"');
    expect(delivery).toContain('className="checklist"');
    expect(delivery).toContain('className="cost-row"');
    expect(delivery).toContain("parseDeliveryVerification");
    expect(delivery).toMatch(/>\s*Accept\s*</);
    expect(delivery).toMatch(/>\s*Reject\s*</);
    expect(delivery).not.toContain("<Screen");
    expect(delivery).not.toContain("stage-companions");
    expect(delivery).not.toContain("Accept the delivery");
    expect(delivery).not.toContain("Reject with feedback");
    expect(delivery).not.toContain("What was built");
    const css = read("../workspace-layout.css");
    expect(css).toContain(".cost-row {");
    expect(css).toContain(".checklist {");
  });
});

// #409: an ask to a companion role carries what the role needs, since it
// sees only what it is sent.
describe("companion asks carry their context", () => {
  test("the requirements author gets the prior revision and the approved inputs; a reviewer gets the ids and the plan", () => {
    const source = read("./stage6.tsx");
    const ask = source.slice(source.indexOf("const askRole"), source.indexOf("setAsk(\"\");", source.indexOf("const askRole")));
    expect(ask).toContain("Product requirements (prior revision, keep its ids)");
    expect(ask).toContain("Approved inputs this document is drawn from");
    expect(ask).toContain("requirementsInput.trim()");
    expect(ask).toContain("The build plan under review");
    expect(ask).toContain("requirementsBlock");
  });
});
