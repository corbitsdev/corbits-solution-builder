/**
 * A slide deck for each stakeholder, kept as an artifact version beside
 * their package so it is exported, imported and listed with everything else.
 *
 * PowerPoint bytes come from `@solutions-builder/tools-deck`'s `render_deck`
 * tool — the same factory stage 5's presentation-creator carries in the
 * sidecar. This file does not generate PowerPoint itself, does not redraw slides onto a
 * template, and does not draw illustrations. What stays here is host-side:
 * the role's saved design and style-guide theme, persisting the tool's
 * bytes, and handing those bytes to a save. A host route never builds a
 * deck; saving slides writes the recorded file.
 */
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import { deckFileName, DECK_MEDIA_TYPE, type TemplateTheme } from "@solutions-builder/app/deck";
import { deck as renderDeckTool } from "@solutions-builder/tools-deck/sidecar-bundle";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";
import { HostError, notFound } from "./errors.js";
import { artifactGraph, readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./project-records.js";
import { deckDesignFor, deckDesignHash, type DeckDesign } from "./deck-settings.js";
import { templateThemeFor } from "./deck-template.js";

export { deckFileName, DECK_MEDIA_TYPE };

/** The kind a deck is recorded as: stage 5, one per stakeholder, never a prompt input. */
export const DECK_KIND: ArtifactKind = "audience_deck";

/**
 * The artifact store takes a version of at most 15 MiB, and a deck is kept
 * there as base64, a third larger than its bytes. A deck past this many
 * bytes is kept as a file in the data directory and its version records
 * where.
 */
const STORE_LIMIT_BYTES = 11 * 1024 * 1024;

function deckFilesDirectory(): string {
  return join(dataDirectory(), "decks");
}

/** A deck version's content: the bytes as a data URI when they fit the store, else a pointer to the file. */
async function deckContent(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength <= STORE_LIMIT_BYTES) return `data:${DECK_MEDIA_TYPE};base64,${Buffer.from(bytes).toString("base64")}`;
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.pptx`;
  await mkdir(deckFilesDirectory(), { recursive: true });
  await writeFile(join(deckFilesDirectory(), name), bytes);
  return JSON.stringify({ deckFile: name, bytes: bytes.byteLength });
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

/** The PowerPoint bytes `render_deck` returned, or null when the tool failed. */
function bytesFromRenderDeck(content: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(content) as { dataUri?: unknown };
    if (typeof parsed.dataUri !== "string") return null;
    const inline = /^data:[^;]+;base64,(.*)$/s.exec(parsed.dataUri);
    if (!inline) return null;
    return new Uint8Array(Buffer.from(inline[1]!, "base64"));
  } catch {
    return null;
  }
}

/**
 * Asks the same `render_deck` factory the sidecar runs. Stage 5 persistence
 * still calls this so a package written in-process has slides beside it;
 * the bytes are the tool's, not a second host renderer.
 */
async function renderDeckBytes(args: {
  projectTitle: string;
  audience: string;
  role: string;
  markdown: string;
  design: DeckDesign;
  theme?: TemplateTheme;
}): Promise<Uint8Array | null> {
  const tool = renderDeckTool({} as never);
  const result = await tool.run(
    {
      id: "host-persist",
      name: "render_deck",
      arguments: {
        projectTitle: args.projectTitle,
        audience: args.audience,
        role: args.role,
        markdown: args.markdown,
        design: {
          theme: args.design.theme,
          typeface: args.design.typeface,
          density: args.design.density,
          notes: args.design.notes,
          guidance: args.design.guidance,
        },
        ...(args.theme ? { theme: args.theme } : {}),
      },
    },
    new AbortController().signal,
  );
  if (result.isError) return null;
  return bytesFromRenderDeck(String(result.content));
}

/**
 * Records the stakeholder's deck as a version of their `audience_deck`,
 * rendered through `render_deck` from the package markdown. Null when the
 * tool has nothing to build from.
 */
export async function writeDeckFor(args: {
  projectId: string;
  projectTitle: string;
  audience: { name: string; role: string };
  packageNodeId: string;
  markdown: string;
  agentRole: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; version: number } | null> {
  const design = await deckDesignFor(args.audience.role);
  const theme = (await templateThemeFor(args.audience.role)) ?? undefined;
  const bytes = await renderDeckBytes({
    projectTitle: args.projectTitle,
    audience: args.audience.name,
    role: args.audience.role.replace(/_/g, " "),
    markdown: args.markdown,
    design,
    ...(theme ? { theme } : {}),
  });
  if (!bytes) return null;
  const written = await writeArtifact(
    {
      projectId: args.projectId,
      kind: DECK_KIND,
      variant: args.audience.name,
      title: `Slides for ${args.audience.name}`,
      content: await deckContent(bytes),
      mediaType: DECK_MEDIA_TYPE,
      sourceVersionIds: [args.packageNodeId],
      provenance: { producer: "agent", agentRole: args.agentRole, promptKey: designKey(design, theme) },
    },
    args.actor,
  );
  return { nodeId: written.nodeId, version: written.version };
}

/** How a deck's provenance names the look it was rendered with. */
function designKey(design: DeckDesign, theme: TemplateTheme | undefined): string {
  return `sb-deck-design:${deckDesignHash(design, [theme ?? null])}`;
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
