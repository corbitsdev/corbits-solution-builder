/**
 * Parses PRODUCT_REQUIREMENTS.md (kit.ts's `requirements-author` role,
 * headings at kit.ts:568-579) into the items `mint_requirements`
 * (`project-workflow/contracts.ts`) mints ids from, and renders the
 * workflow's minted ids back as the block every later specialist reads and
 * may cite.
 *
 * Any id the specialist wrote in the document itself (`FR-1:`, `AC-2)`, ...)
 * is stripped and ignored -- ids are minted by the workflow, in the order
 * items appear here, never invented by a specialist (CL-8862).
 */
import type { RequirementEntry, RequirementKind } from "./stack.js";

const SECTION_KIND: Readonly<Record<string, RequirementKind>> = {
  "functional requirements": "FR",
  "non-functional requirements": "NFR",
  "interface requirements": "IR",
  "acceptance criteria": "AC",
};

export interface RequirementItem {
  readonly kind: RequirementKind;
  readonly text: string;
}

const LIST_ITEM = /^([-*]|\d+[.)])\s+/;
const LEADING_ID = /^\**[A-Z]{2,3}-\d+\**[:.)]?\s*/;

function itemsInSection(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => LIST_ITEM.test(line))
    .map((line) => line.replace(LIST_ITEM, "").replace(LEADING_ID, "").trim())
    .filter((line) => line.length > 0);
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
      for (const text of itemsInSection(buffer.join("\n"))) items.push({ kind: currentKind, text });
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
export function renderRequirementsBlock(requirements: readonly RequirementEntry[]): string {
  if (requirements.length === 0) return "## Requirements (authoritative ids)\n\n(None minted yet.)";
  const lines = requirements.map((r) => `- ${r.id}: ${r.text}`);
  return ["## Requirements (authoritative ids)", "", ...lines].join("\n");
}
