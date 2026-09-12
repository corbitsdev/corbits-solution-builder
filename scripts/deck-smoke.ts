/**
 * The stakeholder deck: a package's deck outline, as the presentation
 * creator writes it, becomes slides. Checks the parse (titles, bullets,
 * notes, the decision request) and the render (a PowerPoint file with one
 * slide per outline item plus a cover and the decision).
 */
import { deckFrom, deckFileName, decisionLinesIn, outlineSlidesIn, renderDeck } from "../apps/hub/src/deck.js";

const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const PACKAGE = `## In short
- Worth pursuing only as a controlled trial.

## Audience: You

### One-pager
Maintainers want good contributions but cannot afford to read every diff cold.

### Deck outline

1. **Problem: PRs are closed because filtering costs too much**  
   You want good contributions, including AI-assisted ones, but cannot afford to distinguish serious work from plausible slop one diff at a time. Today the door is shut [Brainstormer — stage 1].

2. **Proposed solution: \`corbits-triage\` pre-reads PRs against your written bar**  
   The tool elicits a policy from past decisions, runs machine checks first, then uses a whole-policy judge. Source: stage 3 chosen approach.

3. Timeline and expected cost: gated v1, rough only
   A firm estimate follows at stage 7; no approved monetary cost figure exists yet.

### Decision request
- Pursue the controlled trial, or stop before build design deepens.
- **Fund** the next planning step only.

### Source versions
- Brainstormer — stage 1
`;

const slides = outlineSlidesIn(PACKAGE);
check("every numbered item becomes a slide", slides.length === 3, `${slides.length} slides`);
check(
  "a bold lead is the slide's title, with emphasis and code marks removed",
  slides[0]?.title === "Problem: PRs are closed because filtering costs too much" &&
    slides[1]?.title === "Proposed solution: corbits-triage pre-reads PRs against your written bar",
  slides.map((slide) => slide.title).join(" | "),
);
check("an item without bold text takes its line as the title", slides[2]?.title === "Timeline and expected cost: gated v1, rough only", String(slides[2]?.title));
check(
  "the body is shown sentence by sentence, citations and source lines left to the notes",
  slides[0]?.bullets.length === 2 &&
    slides[0].bullets[1] === "Today the door is shut" + "." &&
    slides[1]?.bullets.every((bullet) => !/Source:/.test(bullet)) === true &&
    slides[0].notes.includes("cannot afford"),
  JSON.stringify(slides[0]?.bullets),
);
const decision = decisionLinesIn(PACKAGE);
check("the decision request's lines close the deck", decision.length === 2 && decision[1] === "Fund the next planning step only.", JSON.stringify(decision));
check("a package with no deck outline builds no deck", deckFrom({ projectTitle: "P", audience: "A", role: "r", markdown: "## Audience: A\n\n### One-pager\nText." }) === null);

const deck = deckFrom({ projectTitle: "Triage for open source", audience: "You", role: "project owner", markdown: PACKAGE })!;
const bytes = await renderDeck(deck);
check("the deck renders as a PowerPoint file", bytes.byteLength > 10_000 && String.fromCharCode(bytes[0]!, bytes[1]!) === "PK", `${bytes.byteLength} bytes`);
// The file is read back with the system's unzip: a PowerPoint is a zip of
// XML parts, and that is the one reader every machine this runs on has.
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = await mkdtemp(join(tmpdir(), "sb-deck-"));
const file = join(dir, "deck.pptx");
await Bun.write(file, bytes);
const listing = Bun.spawnSync(["unzip", "-Z1", file]).stdout.toString().split("\n");
const slideFiles = listing.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
check("a cover, one slide per item, and the decision request", slideFiles.length === 5, `${slideFiles.length} slide files`);
const slide2 = Bun.spawnSync(["unzip", "-p", file, "ppt/slides/slide2.xml"]).stdout.toString();
check("a slide carries its title", slide2.includes("Problem: PRs are closed because filtering costs too much"));
const notes = listing.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
check("speaker notes ride with the item slides", notes.length >= 3, `${notes.length} notes files`);
await rm(dir, { recursive: true, force: true });
check("the file is named for the project and the stakeholder", deckFileName("Triage for open source", "Barry Moneyman") === "triage-for-open-source-barry-moneyman-slides.pptx");

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nDeck smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
