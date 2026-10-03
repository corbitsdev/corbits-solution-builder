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
import { queryOptions } from "@tanstack/react-query";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { api, type ArtifactNode } from "../../client.js";
import { keys } from "../../queries/keys.ts";
import { precedingStage, type ReviewState } from "@solutions-builder/app/project-workflow/contracts";
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
  const material = nodes
    .filter(
      (node) =>
        node.supersededByNodeId === null &&
        ((stage > 1 && node.kind === MATERIAL_KIND && node.variant === OPENING_VARIANT) || node.kind === MATERIAL_READING_KIND),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const approved: ChainNode[] = [];
  for (let earlier = 1; earlier < precedingStage(stage, skipped); earlier += 1) {
    const review = reviews[earlier];
    if (!review || review.status !== "approved") continue;
    // Read as the version approved: a document kept in one artifact may have moved past it.
    const node = nodes.find((entry) => entry.artifactId === review.artifactId);
    if (node) approved.push({ ...node, id: versionIdFor(review.artifactId, review.version), version: review.version });
  }
  return [...material, ...approved];
}

/** A design goes as its text; everything else as it is. */
export function chainContent(content: string): string {
  return isHtmlDocument(content) ? designAsText(content, DESIGN_TEXT_CAP) : content;
}

/** The chain as the specialist reads it, an imported stage's history last, or "" when there is nothing to hand over. */
export function renderApprovedChain(items: Inputs, stage: number, history: string): string {
  const parts = [items.length > 0 ? renderInputs(items, stage) : "", history].filter(Boolean);
  return parts.length > 0 ? [CHAIN_LEAD, ...parts, CHAIN_END].join("\n\n") : "";
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
  /** An imported stage's history (`importedHistory`), inside the chain so the transcript folds it away with the rest. */
  readonly history: string;
  readonly skipped: readonly number[];
}): Promise<string> {
  const chain = approvedChainNodes(deps.nodes, deps.reviews, deps.stage, deps.skipped);
  const items: Inputs = [];
  for (const node of chain) {
    try {
      const { content } = await api.artifactContent(deps.tenantId, node.id);
      if (!content.trim()) continue;
      items.push({
        node: { id: node.id, title: node.title, kind: node.kind === MATERIAL_READING_KIND ? MATERIAL_KIND : node.kind, stage: node.stage },
        content: chainContent(content),
      });
    } catch {
      // Unreadable: not handed over, not described.
    }
  }
  return renderApprovedChain(items, deps.stage, deps.history);
}

/**
 * The chain as a query, keyed on the exact nodes it reads: the architect's
 * opening and stage 6's requirements author read one composition. A node's
 * content never changes under its id, so a composed chain is never stale.
 */
export function approvedChainQuery(deps: Omit<Parameters<typeof composeApprovedChain>[0], "history">) {
  const nodeIds = approvedChainNodes(deps.nodes, deps.reviews, deps.stage, deps.skipped).map((node) => node.id);
  return queryOptions({
    queryKey: keys.approvedChain.of(deps.tenantId, deps.stage, nodeIds),
    queryFn: () => composeApprovedChain({ ...deps, history: "" }),
    staleTime: Infinity,
  });
}
