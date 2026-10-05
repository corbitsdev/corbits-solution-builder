/**
 * The PRD written for people (#737): the same requirements as the product
 * requirements document, told for a reader rather than a coding agent, with
 * the design's screens placed beside the parts of the overview they belong
 * to. A separate artifact; the PRD itself is unchanged by it.
 *
 * Pictures are referenced by screen name, as `mockups/<screen>.png`, which is
 * stable before any picture is drawn. The documents download rewrites each
 * reference to the picture file it actually wrote, and the page rewrites it
 * to the picture it drew, both through `resolveMockupReferences`.
 */
import { slug } from "./slug.ts";

export const PRD_FOR_PEOPLE_KIND = "prd_for_people";
export const PRD_FOR_PEOPLE_TITLE = "PRD for people";
/** The file's name in the documents download, as asked for. */
export const PRD_FOR_PEOPLE_FILE = "PRD-for-PEOPLE.md";

const MOCKUPS = "mockups";

/** `mockups/phone-home.png`: how the document refers to a screen's picture. */
export function mockupReference(screenName: string): string {
  return `${MOCKUPS}/${slug(screenName)}.png`;
}

/** The key a reference and a drawn screen share: the screen's slug. */
export function mockupKey(screenName: string): string {
  return slug(screenName);
}

/**
 * Every `mockups/<name>.png` reference whose name is in `available`,
 * replaced by its value: the file in the download, or a data URL on the
 * page. A reference to a screen that was not drawn is left as written.
 */
export function resolveMockupReferences(markdown: string, available: ReadonlyMap<string, string>): string {
  return markdown.replace(/mockups\/([a-z0-9-]+)\.png/g, (whole, name: string) => available.get(name) ?? whole);
}

/**
 * The ask the writer is sent: the PRD, the screens it may picture and how
 * to reference each, and, when the project has them, the approved inputs
 * the PRD was drawn from. The writer sees only what it is sent.
 */
export function composePeopleBrief(input: { readonly requirements: string; readonly screens: readonly string[]; readonly approvedInputs?: string | null; readonly prior?: string | null }): string {
  const screens =
    input.screens.length > 0
      ? [
          `## The design's screens, and how to place each picture`,
          ``,
          `Reference a picture with exactly the path given, as a Markdown image with a caption that says what the reader is looking at: \`![caption](path)\`. The pictures are made from the approved design when the documents are downloaded; do not describe a screen the design does not have.`,
          ``,
          ...input.screens.map((name) => `- ${name}: \`${mockupReference(name)}\``),
        ]
      : [`## The design's screens`, ``, `The design names no screens, so this document carries no pictures. Describe what the person sees in words.`];
  return [
    input.prior ? `Revise the PRD for people against the product requirements below, which have changed since it was written.` : `Write the PRD for people from the product requirements below.`,
    ``,
    ...screens,
    ``,
    `---`,
    ``,
    `## Attached: Product requirements (the source; keep its meaning, cite its ids)`,
    ``,
    input.requirements.trim(),
    ...(input.prior ? [``, `---`, ``, `## Attached: PRD for people (prior revision)`, ``, input.prior.trim()] : []),
    ...(input.approvedInputs ? [``, `---`, ``, `## Attached: Approved inputs the requirements were drawn from`, ``, input.approvedInputs.trim()] : []),
  ].join("\n");
}

/** Text that speaks of the document rather than the application (#742). */
const SELF_REFERENCE = /PRD[- ]for[- ]PEOPLE|\bthis document\b|\brequirements,? explained\b|explained for people|for people to read|plain-language (?:reading|version|telling)/i;

/**
 * The document without any word about itself (#742): a lead paragraph
 * before the title, any paragraph that names the file or calls itself a
 * document, and the closing section that said where it came from, are
 * dropped. Applied where it is recorded and wherever it is shown or
 * downloaded, so a copy written before the rule reads the same.
 */
export function cleanPeopleDocument(markdown: string): string {
  const paragraphs = markdown.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const kept: string[] = [];
  let seenTitle = false;
  let skippingSource = false;
  for (const paragraph of paragraphs) {
    const text = paragraph.trim();
    if (text.length === 0) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text.split("\n")[0] ?? "");
    if (heading) {
      skippingSource = heading[1]!.length <= 2 && /^where this comes from\b/i.test(heading[2] ?? "");
      if (skippingSource) continue;
      if (heading[1]!.length === 1) seenTitle = true;
      kept.push(text);
      continue;
    }
    if (skippingSource) continue;
    // Before the title, a paragraph is the writer's lead line, not the document.
    if (!seenTitle && kept.length === 0 && !text.startsWith("![")) continue;
    if (SELF_REFERENCE.test(text) && !text.startsWith("![") && !/^[-*]\s/.test(text)) continue;
    kept.push(text);
  }
  return kept.join("\n\n").trim();
}
