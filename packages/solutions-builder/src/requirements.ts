/**
 * Parses PRODUCT_REQUIREMENTS.md (kit.ts's `requirements-author` role,
 * headings at kit.ts:568-579) into the items `mint_requirements`
 * (`project-workflow/contracts.ts`) mints ids from, and renders the
 * workflow's minted ids back as the block every later specialist reads and
 * may cite.
 *
 * An id the author wrote in the document itself (`FR-1:`, `AC-2)`, ...) is
 * kept when it fits the section it is in (#347): ids are identifiers,
 * and a revised document that keeps FR-9 means the same FR-9. What is
 * unnumbered, or numbered under the wrong kind, is minted after the highest
 * id in use (CL-8862). The workflow is still what mints: `mintRequirementEntries`
 * is the one rule, used by the reducer and by the interface alike.
 */
import type { RequirementEntry, RequirementKind } from "./stack.js";

const SECTION_KIND: Readonly<Record<string, RequirementKind>> = {
  "functional requirements": "FR",
  "non-functional requirements": "NFR",
  "interface requirements": "IR",
  "acceptance criteria": "AC",
};

/** An item as the document lists it: its kind, its text, and the id the author gave it, when one. */
export interface RequirementItem {
  readonly kind: RequirementKind;
  readonly text: string;
  readonly id?: string;
}

/** The id an item carries if it is well-formed and of the item's own kind. */
function ownId(kind: RequirementKind, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^([A-Z]{2,3})-(\d+)$/.exec(raw);
  if (!match || match[1] !== kind) return undefined;
  return `${kind}-${String(Number(match[2]))}`;
}

/**
 * The entries the workflow mints from `items` (#347): an item keeps its
 * own id when it fits its kind and is not taken; anything else is numbered
 * after the highest id of its kind, in order of appearance.
 */
export function mintRequirementEntries(items: readonly RequirementItem[]): RequirementEntry[] {
  const taken = new Set<string>();
  const highest: Partial<Record<RequirementKind, number>> = {};
  const kept = items.map((item) => {
    const id = ownId(item.kind, item.id);
    if (!id || taken.has(id)) return undefined;
    taken.add(id);
    highest[item.kind] = Math.max(highest[item.kind] ?? 0, Number(id.slice(item.kind.length + 1)));
    return id;
  });
  return items.map((item, index) => {
    let id = kept[index];
    if (!id) {
      const n = (highest[item.kind] ?? 0) + 1;
      highest[item.kind] = n;
      id = `${item.kind}-${String(n)}`;
      taken.add(id);
    }
    return { id, kind: item.kind, text: item.text };
  });
}

/** Whether minting `items` would change what the workflow holds. */
export function requirementsDiffer(items: readonly RequirementItem[], minted: readonly RequirementEntry[]): boolean {
  const wanted = mintRequirementEntries(items);
  if (wanted.length !== minted.length) return true;
  return wanted.some((entry, index) => entry.id !== minted[index]!.id || entry.text !== minted[index]!.text);
}

const LIST_ITEM = /^([-*]|\d+[.)])\s+/;
const LEADING_ID = /^\**[A-Z]{2,3}-\d+[:.)]?\**[:.)]?\s*/;
/** An item written as its own paragraph under the id the specialist gave it (`**FR-1.** The system shall…`), one form the requirements author on `main` used. */
const ID_PARAGRAPH = /^\**[A-Z]{2,3}-\d+[:.)]?\**[:.)]?\s+/;
/** An item as a table row whose first cell is the id (`| FR-1 | The CLI shall… |`), the other form it used. */
const ID_TABLE_ROW = /^\|\s*\**[A-Z]{2,3}-\d+\**\s*\|\s*(.*?)\s*\|?\s*$/;

const WRITTEN_ID = /^\|?\s*\**([A-Z]{2,3}-\d+)/;

/** The items of one section, each with the id the author wrote, if any. */
function itemsInSection(body: string): { text: string; id?: string }[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .map((line): { text: string; id?: string } => {
      const row = ID_TABLE_ROW.exec(line);
      if (row) {
        const id = WRITTEN_ID.exec(line)?.[1];
        return { text: row[1]!.trim(), ...(id ? { id } : {}) };
      }
      if (LIST_ITEM.test(line) || ID_PARAGRAPH.test(line)) {
        const unlisted = line.replace(LIST_ITEM, "");
        const id = WRITTEN_ID.exec(unlisted)?.[1];
        return { text: unlisted.replace(LEADING_ID, "").trim(), ...(id ? { id } : {}) };
      }
      return { text: "" };
    })
    .filter((item) => item.text.length > 0);
}

/** Extracts requirement items from the approved requirements document, in
 *  the order each section lists them -- the order `mint_requirements` mints
 *  ids in (`FR-1`, `FR-2`, ... per kind, in order of appearance). */
export function extractRequirementItems(markdown: string): readonly RequirementItem[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const items: RequirementItem[] = [];
  let currentKind: RequirementKind | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentKind) {
      for (const item of itemsInSection(buffer.join("\n"))) items.push({ kind: currentKind, text: item.text, ...(item.id ? { id: item.id } : {}) });
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentKind = SECTION_KIND[heading[1]!.trim().toLowerCase()] ?? null;
      continue;
    }
    if (currentKind) buffer.push(line);
  }
  flush();
  return items;
}

/** Renders the workflow-minted ids as the block every specialist after
 *  stage 6 reads and may cite (`checkStackCitations`'s `requirementIds`). */
/** The heading the minted ids are rendered under; what a transcript folds on. */
export const REQUIREMENTS_BLOCK_HEADING = "## Requirements (authoritative ids)";

export function renderRequirementsBlock(requirements: readonly RequirementEntry[]): string {
  if (requirements.length === 0) return `${REQUIREMENTS_BLOCK_HEADING}\n\n(None minted yet.)`;
  const lines = requirements.map((r) => `- ${r.id}: ${r.text}`);
  return [REQUIREMENTS_BLOCK_HEADING, "", ...lines].join("\n");
}
