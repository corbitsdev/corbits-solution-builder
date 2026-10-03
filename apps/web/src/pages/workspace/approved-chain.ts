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
 * problem statement, each attached text file, and the text read off each
 * other attached file. A design is handed as its text, never its markup
 * (#219), capped the way a hand-off is.
 */
import { queryOptions } from "@tanstack/react-query";
import { api, type ArtifactNode } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { precedingStage, type ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import { MATERIAL_KIND, MATERIAL_READING_KIND } from "@solutions-builder/app/artifacts";
import { renderInputs, type Inputs } from "@solutions-builder/app/stage-prompt";
import { DESIGN_TEXT_CAP, designAsText } from "../../design-handoff.ts";
import { capMaterialText } from "../../material-reading.ts";
import { isHtmlDocument } from "./guidance.ts";
import { OPENING_VARIANT } from "../../project-list.ts";

export type ChainNode = Pick<ArtifactNode, "id" | "kind" | "stage" | "title" | "artifactId" | "version" | "variant" | "supersededByNodeId" | "createdAt" | "mediaType">;

/** The lines the chain opens and closes with; the transcript folds between them. */
export const CHAIN_LEAD = "What was approved before this stage, and what the person provided:";
export const CHAIN_END = "--- END OF THE RECORD; THIS STAGE'S OPENING FOLLOWS ---";

/**
 * A text file the person attached (#605). It has no reading beside it,
 * because its content is already the text: the file itself is what a
 * specialist is handed. A binary upload is told apart by its type, and is
 * never read here; its reading is.
 */
function isTextMaterial(node: ChainNode): boolean {
  if (node.kind !== MATERIAL_KIND || node.variant === OPENING_VARIANT) return false;
  const mediaType = node.mediaType ?? "";
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

/**
 * What a specialist is handed of the files a person attached, oldest
 * first: each text file as itself, and the reading of each other file.
 */
export function attachedMaterialNodes(nodes: readonly ChainNode[]): ChainNode[] {
  return nodes
    .filter((node) => node.supersededByNodeId === null && (node.kind === MATERIAL_READING_KIND || isTextMaterial(node)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The nodes to hand a stage, in reading order: the material first, then
 * each earlier stage's approved artifact by stage, up to the one before the
 * previous stage (`precedingStage`, past any the surface skipped). The
 * previous stage's artifact is the opening itself, in the form that stage
 * expects (a design as text, the plan behind the frozen stack), so the
 * chain never repeats it.
 */
export function approvedChainNodes(
  nodes: readonly ChainNode[],
  reviews: Readonly<Record<number, ReviewState | undefined>>,
  stage: number,
  skipped: readonly number[] = [],
): ChainNode[] {
  // Stage 1 opens on the problem statement itself, so the record never
  // repeats it there; from stage 2 on it is material like any other.
  const opening = nodes.filter(
    (node) => stage > 1 && node.supersededByNodeId === null && node.kind === MATERIAL_KIND && node.variant === OPENING_VARIANT,
  );
  const material = [...opening, ...attachedMaterialNodes(nodes)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const approved: ChainNode[] = [];
  for (let earlier = 1; earlier < precedingStage(stage, skipped); earlier += 1) {
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

/**
 * One node's content as it is handed over. A reading was capped when it
 * was written; a text file is kept whole, so it is capped here, the cut
 * announced the same way.
 */
export function handedContent(node: ChainNode, content: string): string {
  return isTextMaterial(node) ? capMaterialText(chainContent(content)) : chainContent(content);
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
 * Reads each node's content as it is handed over. A node whose content
 * cannot be read is left out rather than invented.
 */
export async function readHandedItems(tenantId: string, nodes: readonly ChainNode[]): Promise<Inputs> {
  const items: Inputs = [];
  for (const node of nodes) {
    try {
      const { content } = await api.artifactContent(tenantId, node.id);
      if (!content.trim()) continue;
      items.push({
        node: { id: node.id, title: node.title, kind: node.kind === MATERIAL_READING_KIND ? MATERIAL_KIND : node.kind, stage: node.stage },
        content: handedContent(node, content),
      });
    } catch {
      // Unreadable: not handed over, not described.
    }
  }
  return items;
}

/**
 * Reads each chain node's content and renders the chain. A node whose
 * content cannot be read is left out; the opening still goes.
 */
export async function composeApprovedChain(deps: {
  readonly tenantId: string;
  readonly nodes: readonly ChainNode[];
  readonly reviews: Readonly<Record<number, ReviewState | undefined>>;
  readonly stage: number;
  readonly skipped: readonly number[];
}): Promise<string> {
  const chain = approvedChainNodes(deps.nodes, deps.reviews, deps.stage, deps.skipped);
  return renderApprovedChain(await readHandedItems(deps.tenantId, chain), deps.stage);
}

/**
 * The chain as a query, keyed on the exact nodes it reads: the architect's
 * opening and stage 6's requirements author read one composition. A node's
 * content never changes under its id, so a composed chain is never stale.
 */
export function approvedChainQuery(deps: Parameters<typeof composeApprovedChain>[0]) {
  const nodeIds = approvedChainNodes(deps.nodes, deps.reviews, deps.stage, deps.skipped).map((node) => node.id);
  return queryOptions({
    queryKey: keys.approvedChain.of(deps.tenantId, deps.stage, nodeIds),
    queryFn: () => composeApprovedChain(deps),
    staleTime: Infinity,
  });
}
