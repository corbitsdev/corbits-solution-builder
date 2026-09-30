/**
 * Which artifact versions a project can shed (#297), and which it cannot.
 *
 * "Newest" and "the version the project rests on" are different things: a
 * stage may have approved a design's version 1 while versions 2 and 3 were
 * drafted afterwards and never approved, and every later stage's opening,
 * the audit trail and a replay of the decision history read that approved
 * version by id. So a prune keeps every version a decision names, the
 * newest of every document lineage, anything not superseded, and the kinds
 * that are the project's record rather than a draft. The rest is archived,
 * which the hub hides from every listing and read; nothing is deleted.
 * Pure: the caller lists and archives.
 */
import type { ArtifactGraphNode } from "@solutions-builder/app/artifact-graph";
import type { ProjectWorkflowView } from "./project-workflow.ts";

/** What the plan reads off a graph node: identity, lineage, order and whether anything came after it. */
export type PruneNode = Pick<ArtifactGraphNode, "id" | "kind" | "variant" | "stage" | "supersededByNodeId" | "createdAt">;

export type PrunePlan = {
  readonly keep: readonly PruneNode[];
  readonly archive: readonly PruneNode[];
  /** How many document lineages (stage, kind, variant) the project holds. */
  readonly lineages: number;
};

/** Kinds that are the project's record, never a draft to shed. */
const PROTECTED_KINDS: ReadonlySet<string> = new Set(["source_material", "delivery_manifest", "build_evidence"]);

function lineageOf(node: PruneNode): string {
  return `${String(node.stage)}:${node.kind}:${node.variant ?? ""}`;
}

/** Every artifact id the workflow's records point at: reviews, decisions, stakeholder packages. */
export function referencedArtifactIds(view: ProjectWorkflowView | null): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!view) return ids;
  for (const review of Object.values(view.reviews)) if (review) ids.add(review.artifactId);
  if (view.openReview) ids.add(view.openReview.artifactId);
  for (const decision of view.decisions) if (decision.artifactId) ids.add(decision.artifactId);
  for (const ref of Object.values(view.audiencePackages)) ids.add(ref.artifactId);
  return ids;
}

export function prunePlan(nodes: readonly PruneNode[], view: ProjectWorkflowView | null): PrunePlan {
  const referenced = referencedArtifactIds(view);
  const newestByLineage = new Map<string, PruneNode>();
  for (const node of nodes) {
    const key = lineageOf(node);
    const newest = newestByLineage.get(key);
    if (!newest || node.createdAt > newest.createdAt) newestByLineage.set(key, node);
  }
  const kept = new Set<string>();
  for (const node of newestByLineage.values()) kept.add(node.id);
  for (const node of nodes) {
    if (node.supersededByNodeId === null) kept.add(node.id);
    if (referenced.has(node.id)) kept.add(node.id);
    if (PROTECTED_KINDS.has(node.kind)) kept.add(node.id);
  }
  return {
    keep: nodes.filter((node) => kept.has(node.id)),
    archive: nodes.filter((node) => !kept.has(node.id)),
    lineages: newestByLineage.size,
  };
}

/** What the menu says before the second click, and the notice after. */
export function prunePlanSummary(plan: PrunePlan): string {
  const documents = `${String(plan.lineages)} document${plan.lineages === 1 ? "" : "s"}`;
  if (plan.archive.length === 0) return `Nothing to prune: every version across ${documents} is current or named by a decision.`;
  return `Archive ${String(plan.archive.length)} older version${plan.archive.length === 1 ? "" : "s"} across ${documents}, keeping ${String(plan.keep.length)}: the newest of each document and every version a decision names.`;
}
