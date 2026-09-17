/**
 * A slide deck for each stakeholder, built from the deck outline in their
 * package. The package is the record; the deck is a derivative of it, made
 * here without a model call, one slide per outline item, and kept as an
 * artifact version beside the package so it is exported, imported and
 * listed with everything else.
 *
 * Authoring the deck's content and bytes — the outline parse, the look, the
 * PowerPoint (or template) render — no longer lives here; it moved to
 * `@solutions-builder/app/deck` (CL-8006). This file still calls that code
 * in-process, which is an intermediate step, not the destination: the deck
 * tool belongs in the deployed workflow's closure (`workflow-closure.ts`),
 * reached by the `presentation-creator` role's step running in the sidecar,
 * with no hub round trip to render anything. What stays here either way is
 * genuinely host-side: resolving a role's saved design and style guide,
 * drawing illustrations through a connected provider, and persisting the
 * resulting bytes as an artifact version with its lineage.
 */
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import { deckFrom, renderDeck, deckFileName, packageOutlineProblem, DECK_MEDIA_TYPE, DECK_THEMES, type Deck } from "@solutions-builder/app/deck";
import { renderDeckOnTemplate } from "@solutions-builder/app/deck-on-template";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFor } from "@solutions-builder/app/kit";
import { dataDirectory } from "./paths.js";
import { HostError, notFound } from "./errors.js";
import { artifactGraph, readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./installer-bridge.js";
import { deckDesignFor, deckDesignHash, type DeckDesign } from "./deck-settings.js";
import { templateFor, templateThemeFor } from "./deck-template.js";
import { artDirection, chatSource, illustration, illustrationPrompt, imageSource } from "./deck-images.js";
import { recordHostUsage, recordIllustrations } from "./spend.js";

export { deckFileName, DECK_MEDIA_TYPE };

/** The kind a deck is recorded as: stage 5, one per stakeholder, never a prompt input. */
export const DECK_KIND: ArtifactKind = "audience_deck";

/**
 * The illustrations a role's design asks for. A chat model that has read the
 * whole deck says which slides deserve a picture and what each should show;
 * the provider's image model then draws those, in the house manner. Null
 * when the design asks for none. Throws when it asks and no connected
 * provider can read or draw.
 */
export async function illustrationsFor(deck: Deck, projectId?: string): Promise<Map<string, Uint8Array> | null> {
  if (deck.design.images === "none") return null;
  const source = await imageSource();
  if (!source) {
    throw new HostError(
      "provider_unavailable",
      "The slides ask for images, but no connected provider lists an image model (gpt-image-1, dall-e-3 or a Grok image model). Connect one, or set Images to none for this role in Settings, Stakeholder decks.",
      {},
      false,
    );
  }
  const reader = await chatSource();
  if (!reader) {
    throw new HostError(
      "provider_unavailable",
      "The slides ask for images, but no connected provider has a chat model to read the deck with. Connect one, or set Images to none for this role in Settings, Stakeholder decks.",
      {},
      false,
    );
  }
  const direction = await artDirection({
    source: reader,
    mode: deck.design.images,
    projectTitle: deck.projectTitle,
    audience: deck.audience,
    role: deck.role,
    guidance: deck.design.guidance,
    slides: deck.slides,
    decision: deck.decision,
  });
  const colour = DECK_THEMES[deck.design.theme].label.toLowerCase();
  const images = new Map<string, Uint8Array>();
  for (const [key, subject] of direction) {
    images.set(key, await illustration(source, illustrationPrompt({ subject, colour })));
  }
  if (projectId) {
    // The reader's call streams and reports no counts; the pictures are
    // counted, since image models price per picture.
    await recordHostUsage({ projectId, purpose: "deck art direction", provider: reader.providerId, model: reader.model, tokens: null }).catch(() => undefined);
    await recordIllustrations({ projectId, provider: source.providerId, model: source.model, images: images.size }).catch(() => undefined);
  }
  return images;
}

/**
 * The artifact store takes a version of at most 15 MiB, and a deck is kept
 * there as base64, a third larger than its bytes. A deck past this many
 * bytes is kept as a file in the data directory and its version records
 * where; it is rebuilt from the package if the file is ever gone.
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

/**
 * Builds the stakeholder's deck from their package and records it as a
 * version of their `audience_deck`, built from the package version. Null
 * when the package carries no deck outline to build from.
 */
export async function writeDeckFor(args: {
  projectId: string;
  projectTitle: string;
  audience: { name: string; role: string };
  packageNodeId: string;
  markdown: string;
  agentRole: string;
  actor: { principalId: string };
  /**
   * Whether to draw the illustrations the role's design asks for. Off when
   * the deck is built as a package is written — the person is waiting on
   * the package, not on nine images — and on when they ask for the slides.
   */
  illustrate?: boolean;
}): Promise<{ nodeId: string; version: number } | null> {
  const design = await deckDesignFor(args.audience.role);
  const template = await templateFor(args.audience.role);
  const theme = template ? ((await templateThemeFor(args.audience.role)) ?? undefined) : undefined;
  const plain = deckFrom({
    projectTitle: args.projectTitle,
    audience: args.audience.name,
    role: args.audience.role.replace(/_/g, " "),
    markdown: args.markdown,
    design,
    ...(theme ? { theme } : {}),
  });
  if (!plain) return null;
  const images = args.illustrate ? await illustrationsFor(plain, args.projectId) : null;
  const deck: Deck = images ? { ...plain, images } : plain;
  // On the person's own PowerPoint when the role has one: its masters,
  // layouts and media, our slides. Otherwise drawn from the design.
  const bytes = template ? await renderDeckOnTemplate(template.bytes, deck) : await renderDeck(deck);
  const written = await writeArtifact(
    {
      projectId: args.projectId,
      kind: DECK_KIND,
      variant: args.audience.name,
      title: `Slides for ${args.audience.name}`,
      content: await deckContent(bytes),
      mediaType: DECK_MEDIA_TYPE,
      sourceVersionIds: [args.packageNodeId],
      // The look it was built with rides along, so a changed design is a new version.
      provenance: { producer: "agent", agentRole: args.agentRole, promptKey: designKey(design, template?.hash, images !== null) },
    },
    args.actor,
  );
  return { nodeId: written.nodeId, version: written.version };
}

/** How a deck's provenance names the look it was built with: the design, the style guide file, and whether it carries the images asked for. */
function designKey(design: DeckDesign, templateHash: string | undefined, illustrated: boolean): string {
  return `sb-deck-design:${deckDesignHash(design, [templateHash ?? null, design.images !== "none" ? illustrated : true])}`;
}

/**
 * The deck built from this package version with the role's current design,
 * building it now when none has been: a package written before decks
 * existed, one whose build failed, or one whose role's design has changed
 * since. The person asks for slides from the package they can see, so the
 * answer is the slides for that version, never a rewrite of the package.
 */
export async function ensureDeckFor(args: {
  packageNodeId: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; built: boolean }> {
  // A second request for slides still being built joins the build rather
  // than starting another: a build draws images and records a version, and
  // two of each for one press-twice is a mess the person did not ask for.
  const inFlight = building.get(args.packageNodeId);
  if (inFlight) return inFlight;
  const build = findOrBuildDeck(args).finally(() => building.delete(args.packageNodeId));
  building.set(args.packageNodeId, build);
  return build;
}

/** The builds under way, by package version, for the request that arrives mid-build. */
const building = new Map<string, Promise<{ nodeId: string; built: boolean }>>();

async function findOrBuildDeck(args: {
  packageNodeId: string;
  actor: { principalId: string };
}): Promise<{ nodeId: string; built: boolean }> {
  const { node, content } = await readArtifactNode(args.packageNodeId);
  if (node.kind !== "audience_package") {
    throw new HostError("validation_failed", "Slides are built from a stakeholder's package.", {}, false);
  }
  const project = await readProject(node.projectId);
  if (!project) throw notFound("That project");
  const audience = project.policy.audiences?.find((entry) => entry.name === node.variant) ?? {
    name: node.variant ?? "Stakeholder",
    role: "stakeholder",
  };
  const { nodes, edges } = await artifactGraph(node.projectId);
  const current = designKey(await deckDesignFor(audience.role), (await templateFor(audience.role))?.hash, true);
  const existing = nodes.find(
    (candidate) =>
      candidate.kind === DECK_KIND &&
      candidate.supersededByNodeId === null &&
      edges.some((edge) => edge.childNodeId === candidate.id && edge.sourceNodeId === node.id) &&
      (candidate.provenance as { promptKey?: unknown } | null)?.promptKey === current,
  );
  // A version whose bytes live in a file that is gone is no deck at all.
  if (existing && (await deckBytesOf((await readArtifactNode(existing.id)).content)) !== null) return { nodeId: existing.id, built: false };
  const written = await writeDeckFor({
    projectId: node.projectId,
    projectTitle: project.title,
    audience,
    packageNodeId: node.id,
    markdown: content,
    agentRole: agentFor(5).id,
    actor: args.actor,
    illustrate: true,
  });
  if (!written) {
    // Every package is written with an outline; one without is a version
    // from before that rule, and the person is told what to add.
    throw new HostError(
      "validation_failed",
      `There is nothing to build slides from: ${packageOutlineProblem(content) ?? "the package's deck outline is empty"}.`,
      {},
      false,
    );
  }
  return { nodeId: written.nodeId, built: true };
}
