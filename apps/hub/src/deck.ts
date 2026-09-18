/**
 * A stakeholder's slide deck, as recorded beside their package: reading its
 * bytes back for download and finding which deck a package's slides live on.
 *
 * PowerPoint bytes come from the sidecar's own `render_deck` step — this
 * file never renders a deck. A host route never builds one either; saving
 * slides writes the file the sidecar already produced.
 */
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import { deckFileName, DECK_MEDIA_TYPE } from "@solutions-builder/app/deck";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";
import { HostError, notFound } from "./errors.js";
import { artifactGraph, readArtifactNode } from "./projects.js";
import { readProject } from "./project-records.js";

export { deckFileName, DECK_MEDIA_TYPE };

/** The kind a deck is recorded as: stage 5, one per stakeholder, never a prompt input. */
export const DECK_KIND: ArtifactKind = "audience_deck";

function deckFilesDirectory(): string {
  return join(dataDirectory(), "decks");
}

/** A deck version's bytes, from the store or from the file it points at; null when the file is gone. */
export async function deckBytesOf(content: string): Promise<Uint8Array | null> {
  const inline = /^data:[^;]+;base64,(.*)$/s.exec(content);
  if (inline) return new Uint8Array(Buffer.from(inline[1]!, "base64"));
  try {
    const pointer = JSON.parse(content) as { deckFile?: unknown };
    if (typeof pointer.deckFile !== "string" || !/^[a-f0-9]+\.pptx$/.test(pointer.deckFile)) return null;
    return new Uint8Array(await readFile(join(deckFilesDirectory(), pointer.deckFile)));
  } catch {
    return null;
  }
}

/**
 * The slides already recorded for this package (or this deck node). A host
 * route uses this to save; it never builds. Throws when the package has no
 * deck beside it yet.
 */
export async function deckForPackage(packageNodeId: string): Promise<{ nodeId: string }> {
  const { node } = await readArtifactNode(packageNodeId);
  if (node.kind === DECK_KIND) {
    if ((await deckBytesOf((await readArtifactNode(node.id)).content)) === null) {
      throw new HostError("internal_error", "The slides were recorded without their bytes.");
    }
    return { nodeId: node.id };
  }
  if (node.kind !== "audience_package") {
    throw new HostError("validation_failed", "Slides are saved from a stakeholder's package or its deck.", {}, false);
  }
  const project = await readProject(node.projectId);
  if (!project) throw notFound("That project");
  const { nodes, edges } = await artifactGraph(node.projectId);
  const existing = nodes.find(
    (candidate) =>
      candidate.kind === DECK_KIND &&
      candidate.supersededByNodeId === null &&
      edges.some((edge) => edge.childNodeId === candidate.id && edge.sourceNodeId === node.id),
  );
  if (!existing || (await deckBytesOf((await readArtifactNode(existing.id)).content)) === null) {
    throw new HostError(
      "validation_failed",
      "There are no slides for this package yet. Stage 5 records them when it writes the package.",
      {},
      false,
    );
  }
  return { nodeId: existing.id };
}
