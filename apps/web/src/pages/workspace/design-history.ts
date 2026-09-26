/**
 * A project's design history, oldest first. Every persisted stage draft is
 * its own artifact at version 1 (they chain through `supersedes`, not
 * through artifact versions), so `node.version` cannot order them: the six
 * "Version 1" entries the Workout Log project showed, opening on whichever
 * the graph listed last (#86). Order by when each was saved, with the
 * artifact version as the tie-break for the rare artifact revised in place.
 */
import type { ArtifactNode } from "../../client.ts";

export function designHistory(nodes: readonly ArtifactNode[]): ArtifactNode[] {
  return nodes
    .filter((node) => node.kind === "design_artifact")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.version - right.version);
}

/** The label a design gets in the history: its place in the order, which is
 *  what a person means by "version 3", not the artifact's own counter. */
export function designOrdinal(designs: readonly ArtifactNode[], design: ArtifactNode): number {
  const index = designs.findIndex((entry) => entry.id === design.id);
  return index < 0 ? design.version : index + 1;
}
