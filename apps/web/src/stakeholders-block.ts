/**
 * The roster the Presentation creator confirms at Concept approval, read
 * off its reply (#722). The prompt asks for exactly one fenced block opened
 * with ```json stakeholders; the JSON is parsed leniently, the way the
 * Architect's stack block is (a trailing comma forgiven, nothing else), and
 * the shape is checked strictly: anything short of a clean roster is null,
 * never a best-effort guess, since what is read here is saved as the
 * project's policy.
 */
import { STAKEHOLDER_ROLE_IDS } from "@solutions-builder/app/stakeholder-roles";

export type StakeholdersBlock = {
  readonly audiences: readonly { readonly name: string; readonly role: string }[];
  readonly quorum: number;
};

const MAX_NAME = 80;

export function parseJsonLeniently(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/**
 * Every body of a fenced block opened with ```json <tag>, in order. The tag
 * is required: unlike the stack block, which sits under a heading of its
 * own, nothing else bounds these, and a reply may carry other JSON.
 */
export function fencedBlocks(body: string, tag: string): string[] {
  const re = new RegExp(`\`\`\`(?:json|jsonc|JSON)[ \\t]+${tag}[ \\t]*\\r?\\n([\\s\\S]*?)\`\`\``, "g");
  return [...body.matchAll(re)].map((match) => match[1]!);
}

function rosterOf(value: unknown): StakeholdersBlock | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { audiences, quorum } = value as Record<string, unknown>;
  if (!Array.isArray(audiences) || audiences.length === 0) return null;
  if (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum < 0 || quorum > audiences.length) return null;
  const seen = new Set<string>();
  const entries: { name: string; role: string }[] = [];
  for (const entry of audiences) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, role } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof role !== "string") return null;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME) return null;
    if (!(STAKEHOLDER_ROLE_IDS as readonly string[]).includes(role)) return null;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ name: trimmed, role });
  }
  return { audiences: entries, quorum };
}

/**
 * The roster a reply confirms, or null: no block, two blocks (the prompt
 * asks for exactly one, and two is a reply that could not decide), JSON
 * that does not parse, or a shape with anything wrong in it — a role the
 * project does not know, a blank or repeated name, a quorum past the count.
 */
export function stakeholdersBlockOf(body: string): StakeholdersBlock | null {
  const blocks = fencedBlocks(body, "stakeholders");
  if (blocks.length !== 1) return null;
  const json = parseJsonLeniently(blocks[0]!);
  if (json === undefined) return null;
  return rosterOf(json);
}
