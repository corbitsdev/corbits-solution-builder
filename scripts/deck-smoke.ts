/**
 * The stakeholder deck: a package's deck outline, as the presentation
 * creator writes it, becomes slides. Checks the parse (titles, bullets,
 * notes, the decision request) and the render (a PowerPoint file with one
 * slide per outline item plus a cover and the decision).
 */
import { mkdtemp as mkdtempTop } from "node:fs/promises";
import { tmpdir as tmpdirTop } from "node:os";
import { join as joinTop } from "node:path";
// The settings the smoke saves go to a data directory of its own.
process.env["SOLUTIONS_BUILDER_DATA_DIR"] = await mkdtempTop(joinTop(tmpdirTop(), "sb-deck-settings-"));
const { deckFrom, deckFileName, decisionLinesIn, outlineSlidesIn, renderDeck, packageOutlineProblem } = await import(
  "../packages/solutions-builder/src/deck.js"
);

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

// Every package must carry a slide outline: the writer refuses one without,
// and the reason it gives names what is missing.
check("a package with the outline is a package", packageOutlineProblem(PACKAGE) === null);
check(
  "a package with no deck outline section is refused for that reason",
  /no "### Deck outline" section/.test(packageOutlineProblem("## Audience: A\n\n### One-pager\nText.") ?? ""),
  String(packageOutlineProblem("## Audience: A\n\n### One-pager\nText.")),
);
check(
  "an outline written as bullets or sub-headings, not numbered slides, is refused for that reason",
  /no numbered slides/.test(packageOutlineProblem("## Audience: A\n\n### Deck outline\n- Problem\n- Solution\n\n#### Slide 1\nText.") ?? ""),
  String(packageOutlineProblem("## Audience: A\n\n### Deck outline\n- Problem\n- Solution")),
);
check(
  "a level-two outline heading is not the section the slides are read from",
  packageOutlineProblem("## Audience: A\n\n## Deck outline\n1. **One**\n   Text.") !== null,
);

const deck = deckFrom({ projectTitle: "Triage for open source", audience: "You", role: "project owner", markdown: PACKAGE })!;
const bytes = await renderDeck(deck);

// The same outline, rendered through the stage 5 workflow tool a deployed
// lifecycle actually calls (`render_deck`), not the bare authoring function
// above. This is the sidecar's own entry point, run in-process.
{
  const { deck: renderDeckTool } = await import("../packages/tools-deck/src/sidecar-bundle.js");
  const tool = renderDeckTool({} as never);
  const controller = new AbortController();
  const result = await tool.run(
    {
      id: "smoke-1",
      name: "render_deck",
      arguments: { projectTitle: "Triage for open source", audience: "You", role: "project owner", markdown: PACKAGE },
    },
    controller.signal,
  );
  check("render_deck tool succeeds", result.isError !== true, String(result.content).slice(0, 200));
  const parsed = result.isError ? null : (JSON.parse(result.content as string) as { fileName: string; mediaType: string; dataUri: string });
  check(
    "render_deck returns a named PowerPoint data: URI",
    parsed !== null && parsed.fileName === deckFileName("Triage for open source", "You") && parsed.dataUri.startsWith("data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,"),
    parsed ? parsed.fileName : "n/a",
  );
}
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

// A role's design decides the look: its colour and typeface in the slide
// parts, how many points a slide carries, and whether notes ride along.
const designed = deckFrom({
  projectTitle: "Triage",
  audience: "Barry",
  role: "budget approver",
  markdown: PACKAGE,
  design: { theme: "navy", typeface: "Georgia", density: "sparse", notes: false, images: "none", template: null, guidance: "Lead with cost." },
})!;
check("density caps the points a slide shows", designed.slides.every((slide) => slide.bullets.length <= 3));
const designedBytes = await renderDeck(designed);
const dir2 = await mkdtemp(join(tmpdir(), "sb-deck-"));
const file2 = join(dir2, "deck.pptx");
await Bun.write(file2, designedBytes);
const cover = Bun.spawnSync(["unzip", "-p", file2, "ppt/slides/slide1.xml"]).stdout.toString();
check("the role's colour and typeface are in the slides", cover.includes("1E3A8A") && cover.includes("Georgia"), `${cover.includes("1E3A8A")}/${cover.includes("Georgia")}`);
// The library writes a notes part for every slide; with notes off, none of
// them carries the item's text.
const notesParts = Bun.spawnSync(["unzip", "-Z1", file2]).stdout.toString().split("\n").filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
const notesText = notesParts.map((part) => Bun.spawnSync(["unzip", "-p", file2, part]).stdout.toString()).join("");
check("speaker notes can be left off", !notesText.includes("cannot afford"), `${notesParts.length} notes parts`);
await rm(dir2, { recursive: true, force: true });

// A style guide's theme is read from its XML: colours by sRGB or a system
// colour's last value, typefaces from the major and minor fonts.
const { themeFromXml, themeFromPptx } = await import("../packages/tools-deck/src/deck-theme.js");
const THEME_XML = `<a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Playfair Display"/></a:majorFont><a:minorFont><a:latin typeface="Source Sans Pro"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
const parsedTheme = themeFromXml(THEME_XML);
check(
  "a style guide's theme is read: accent, ink, paper, and both typefaces",
  parsedTheme.accent === "4472C4" && parsedTheme.ink === "000000" && parsedTheme.paper === "FFFFFF" && parsedTheme.titleFace === "Playfair Display" && parsedTheme.bodyFace === "Source Sans Pro",
  JSON.stringify(parsedTheme),
);
// Our own rendered deck is a PowerPoint with a theme part and a slide size, so it reads as one.
const ownTheme = await themeFromPptx(bytes);
check("a PowerPoint file's theme and slide size are read", typeof ownTheme.ratio === "number" && ownTheme.ratio > 1.7, JSON.stringify(ownTheme));

// With a theme and images, the deck is drawn with the theme's colours and
// faces, and carries the pictures as media parts.
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const pictured = deckFrom({
  projectTitle: "Triage",
  audience: "Barry",
  role: "budget approver",
  markdown: PACKAGE,
  design: { ...designed.design, images: "all" },
  theme: parsedTheme,
  images: new Map([["cover", PNG], ["0", PNG], ["1", PNG]]),
})!;
const picturedBytes = await renderDeck(pictured);
const dir3 = await mkdtemp(join(tmpdir(), "sb-deck-"));
const file3 = join(dir3, "deck.pptx");
await Bun.write(file3, picturedBytes);
const parts3 = Bun.spawnSync(["unzip", "-Z1", file3]).stdout.toString().split("\n");
const media = parts3.filter((name) => /^ppt\/media\/image[\w-]*\.png$/.test(name));
check("the illustrations ride in the deck as media parts", media.length >= 3, `${media.length} media parts`);
const cover3 = Bun.spawnSync(["unzip", "-p", file3, "ppt/slides/slide1.xml"]).stdout.toString();
check("the style guide's accent and title face are drawn with", cover3.includes("4472C4") && cover3.includes("Playfair Display"), `${cover3.includes("4472C4")}/${cover3.includes("Playfair Display")}`);
await rm(dir3, { recursive: true, force: true });

// A deck built on a person's own PowerPoint: the template keeps its master,
// layouts and theme; its slides go; ours are written on its layouts. The
// fixture is a small deck with a master carrying title and body
// placeholders, made with the same library, so the test needs no file.
{
  const { renderDeckOnTemplate, templateCanCarryADeck } = await import("../packages/solutions-builder/src/deck-on-template.js");
  const { default: PptxGenJS } = await import("pptxgenjs");
  const fixture = new PptxGenJS();
  fixture.layout = "LAYOUT_16x9";
  fixture.defineSlideMaster({
    title: "HOUSE",
    background: { color: "0B3D91" },
    objects: [
      { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.4, w: 9, h: 1 } } },
      { placeholder: { options: { name: "body", type: "body", x: 0.5, y: 1.6, w: 9, h: 3.4 } } },
    ],
  });
  const seed = fixture.addSlide({ masterName: "HOUSE" });
  seed.addText("Old slide", { placeholder: "title" });
  // A photograph on the template's own slide: reached by nothing once that
  // slide is gone, so it must not ride along in every deck.
  seed.addImage({ data: `image/png;base64,${Buffer.from(PNG).toString("base64")}`, x: 1, y: 1, w: 1, h: 1 });
  const templateBytes = new Uint8Array((await fixture.write({ outputType: "nodebuffer" })) as Buffer);
  check("a PowerPoint with layouts can carry a deck", await templateCanCarryADeck(templateBytes));
  check("a file that is not a PowerPoint cannot", !(await templateCanCarryADeck(new Uint8Array([1, 2, 3]))));

  const built = await renderDeckOnTemplate(templateBytes, pictured);
  const dir4 = await mkdtemp(join(tmpdir(), "sb-deck-"));
  const file4 = join(dir4, "deck.pptx");
  await Bun.write(file4, built);
  const parts4 = Bun.spawnSync(["unzip", "-Z1", file4]).stdout.toString().split("\n");
  const slides4 = parts4.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  check("the template's slides are gone and ours are in their place: a cover, one per item, the decision", slides4.length === 5, `${slides4.length} slides`);
  check("the template's master and theme survive", parts4.some((name) => /^ppt\/slideMasters\/slideMaster1\.xml$/.test(name)) && parts4.some((name) => /^ppt\/theme\/theme1\.xml$/.test(name)));
  const rels2 = Bun.spawnSync(["unzip", "-p", file4, "ppt/slides/_rels/slide2.xml.rels"]).stdout.toString();
  check("each slide is written on one of the template's layouts", /slideLayouts\/slideLayout\d+\.xml/.test(rels2), rels2.slice(0, 160));
  const slide2xml = Bun.spawnSync(["unzip", "-p", file4, "ppt/slides/slide2.xml"]).stdout.toString();
  check(
    "the slide fills the layout's title and body placeholders",
    slide2xml.includes('<p:ph type="title"') && slide2xml.includes('<p:ph type="body"') && slide2xml.includes("Problem: PRs are closed because filtering costs too much"),
  );
  // The library keeps a master's background on its layout; a template from
  // PowerPoint keeps it on the master. Either way it is still there.
  const surfaces = parts4
    .filter((name) => /^ppt\/(slideMasters|slideLayouts)\/[^/]+\.xml$/.test(name))
    .map((name) => Bun.spawnSync(["unzip", "-p", file4, name]).stdout.toString())
    .join("");
  check("the template's own background is what the slides sit on", surfaces.includes("0B3D91"));
  const media4 = parts4.filter((name) => /^ppt\/media\/deck-image-\d+\.png$/.test(name));
  check("the illustrations ride along as media parts", media4.length === 3, `${media4.length} media parts`);
  const leftover = parts4.filter((name) => /^ppt\/media\/[^/]+$/.test(name) && !/deck-image-/.test(name));
  check("media only the template's own slides reached is left out", leftover.length === 0, leftover.join(","));
  const { deckBytesOf } = await import("../apps/hub/src/deck.js");
  check(
    "a deck version's bytes come from the store, and a pointer to a file that is gone is no deck",
    (await deckBytesOf(`data:x/y;base64,${Buffer.from("PK").toString("base64")}`))?.byteLength === 2 &&
      (await deckBytesOf(JSON.stringify({ deckFile: "0123456789abcdef.pptx" }))) === null &&
      (await deckBytesOf("not a deck")) === null,
  );
  const presentation4 = Bun.spawnSync(["unzip", "-p", file4, "ppt/presentation.xml"]).stdout.toString();
  check("the presentation lists exactly our slides", (presentation4.match(/<p:sldId /g) ?? []).length === 5);
  // unzip reads square brackets as a pattern; the part's name has them.
  const types4 = Bun.spawnSync(["unzip", "-p", file4, "\\[Content_Types\\].xml"]).stdout.toString();
  check("the package declares every slide part it carries", slides4.every((name) => types4.includes(`PartName="/${name}"`)));
  await rm(dir4, { recursive: true, force: true });
}

// Six roles' settings changed at once — what six selects on one screen do
// while the host is busy — must all land; each save rewrites the whole file.
{
  const { DECK_ROLES, deckSettings, saveDeckDesign } = await import("../apps/hub/src/deck-settings.js");
  await Promise.all(DECK_ROLES.map((role) => saveDeckDesign(role, { images: "some" })));
  const settings = await deckSettings();
  const landed = DECK_ROLES.filter((role) => settings[role].images === "some");
  check("settings saved for every role at once all land", landed.length === DECK_ROLES.length, `${landed.length} of ${DECK_ROLES.length}`);
  const { saveDesignerSettings, designerSettings } = await import("../apps/hub/src/designer-settings.js");
  await Promise.all([saveDesignerSettings({ surface: "dark" }), saveDesignerSettings({ language: "Inter, one accent." })]);
  const designer = await designerSettings();
  check("two designer settings saved at once both land", designer.surface === "dark" && designer.language === "Inter, one accent.");
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nDeck smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
