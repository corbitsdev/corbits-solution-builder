/**
 * The packages Concept approval shows: one per stakeholder, the newest,
 * whatever the graph holds (#122). A package written before every write
 * chained onto its predecessor left two live nodes for one stakeholder,
 * and the page showed a tab for each. A package with no stakeholder name
 * -- the stage's own persisted draft -- is not a stakeholder's package.
 */
import type { ArtifactNode } from "./client.js";

export function packagesByStakeholder(
  nodes: readonly ArtifactNode[],
  audiences: readonly { readonly name: string }[],
): ArtifactNode[] {
  const rank = (name: string | null) => {
    const index = audiences.findIndex((audience) => audience.name === name);
    return index === -1 ? audiences.length : index;
  };
  const newest = new Map<string, ArtifactNode>();
  for (const node of nodes) {
    if (node.kind !== "audience_package" || node.supersededByNodeId !== null || !node.variant) continue;
    const held = newest.get(node.variant);
    if (!held || node.version > held.version || (node.version === held.version && node.createdAt > held.createdAt)) {
      newest.set(node.variant, node);
    }
  }
  return [...newest.values()].sort((a, b) => rank(a.variant) - rank(b.variant));
}
