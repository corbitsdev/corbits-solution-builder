/**
 * What a stage's specialist is handed before its own opening (#423): the
 * one approved version of each earlier stage's artifact, and the person's
 * material, rendered the way solutions-builder-alpha main rendered them for
 * every draft round (`renderInputs`, `stage-prompt.ts`).
 *
 * Which version is approved is the workflow's own record: `reviews[s]`
 * names the exact artifact and version a person approved at stage `s`.
 * Twenty drafts of a brief are twenty nodes; one of them is in the review,
 * and that one goes. Material is what the person handed over: the opening
 * problem statement and the text read off each attached file. A design is
 * handed as its text, never its markup (#219), capped the way a hand-off is.
 */
import { api, type ArtifactNode } from "../../client.js";
import type { ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import { MATERIAL_KIND, MATERIAL_READING_KIND } from "@solutions-builder/app/artifacts";
import { renderInputs, type Inputs } from "@solutions-builder/app/stage-prompt";
import { DESIGN_TEXT_CAP, designAsText } from "../../design-handoff.ts";
import { isHtmlDocument } from "./guidance.ts";
import { OPENING_VARIANT } from "../../project-list.ts";

export type ChainNode = Pick<ArtifactNode, "id" | "kind" | "stage" | "title" | "artifactId" | "version" | "variant" | "supersededByNodeId" | "createdAt">;

/** The lines the chain opens and closes with; the transcript folds between them. */
export const CHAIN_LEAD = "What was approved before this stage, and what the person provided:";
export const CHAIN_END = "--- END OF THE RECORD; THIS STAGE'S OPENING FOLLOWS ---";

/**
 * The nodes to hand a stage, in reading order: the material first, then
 * each earlier stage's approved artifact by stage, up to `stage - 2`. The
 * previous stage's artifact is the opening itself, in the form that stage
 * expects (a design as text, the plan behind the frozen stack), so the
 * chain never repeats it.
 */
export function approvedChainNodes(
  nodes: readonly ChainNode[],
  reviews: Readonly<Record<number, ReviewState | undefined>>,
  stage: number,
): ChainNode[] {
  // Stage 1 opens on the problem statement itself, so the record never
  // repeats it there; from stage 2 on it is material like any other.
  const material = nodes
    .filter(
      (node) =>
        node.supersededByNodeId === null &&
        ((stage > 1 && node.kind === MATERIAL_KIND && node.variant === OPENING_VARIANT) || node.kind === MATERIAL_READING_KIND),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const approved: ChainNode[] = [];
  for (let earlier = 1; earlier < stage - 1; earlier += 1) {
    const review = reviews[earlier];
    if (!review || review.status !== "approved") continue;
    const node = nodes.find((entry) => entry.artifactId === review.artifactId && entry.version === review.version);
    if (node) approved.push(node);
  }
  return [...material, ...approved];
}

/** A design goes as its text; everything else as it is. */
export function chainContent(content: string): string {
  return isHtmlDocument(content) ? designAsText(content, DESIGN_TEXT_CAP) : content;
}

/** The chain as the specialist reads it, or "" when there is nothing to hand over. */
export function renderApprovedChain(items: Inputs, stage: number): string {
  if (items.length === 0) return "";
  return `${CHAIN_LEAD}\n\n${renderInputs(items, stage)}\n\n${CHAIN_END}`;
}

/** An opening mail split for the transcript: what precedes the chain, the chain, and the stage's own lead. Null for any other message. */
export function splitChain(text: string): { readonly before: string; readonly chain: string; readonly after: string } | null {
  const start = text.indexOf(CHAIN_LEAD);
  const end = text.indexOf(CHAIN_END);
  if (start === -1 || end === -1 || end < start) return null;
  return {
    before: text.slice(0, start).trim(),
    chain: text.slice(start + CHAIN_LEAD.length, end).trim(),
    after: text.slice(end + CHAIN_END.length).trim(),
  };
}

/**
 * Reads each chain node's content and renders the chain. A node whose
 * content cannot be read is left out rather than invented; the opening
 * still goes.
 */
export async function composeApprovedChain(deps: {
  readonly tenantId: string;
  readonly nodes: readonly ChainNode[];
  readonly reviews: Readonly<Record<number, ReviewState | undefined>>;
  readonly stage: number;
}): Promise<string> {
  const chain = approvedChainNodes(deps.nodes, deps.reviews, deps.stage);
  const items: Inputs = [];
  for (const node of chain) {
    const { content } = await api.artifactContent(deps.tenantId, node.id);
    if (!content.trim()) continue;
    items.push({
      node: { id: node.id, title: node.title, kind: node.kind === MATERIAL_READING_KIND ? MATERIAL_KIND : node.kind, stage: node.stage },
      content: chainContent(content),
    });
  }
  return renderApprovedChain(items, deps.stage);
}
