/**
 * A stakeholder's slides as the app draws them now (#766): from the
 * package's deck outline, with the role's saved look, the design documents'
 * theme and the approved GUI's screens, the same rule the Slides tab and the
 * Concept approval exports follow. The documents download uses this so what
 * it hands out is what the person sees, whatever the recorded file holds.
 */
import { api, type ArtifactNode } from "./client.js";
import { deckDesignFor } from "./deck-design-settings.ts";
import { buildPackageDeck } from "./deck-save.ts";
import { cachedFramedMockupShots } from "./mockup-cache.ts";
import { isHtmlDocument } from "./pages/workspace/guidance.ts";

/** The package a deck was drawn from: the newest of the same stakeholder written before it, else the newest. */
export function packageOfDeck(nodes: readonly ArtifactNode[], deck: Pick<ArtifactNode, "stage" | "variant" | "createdAt">): ArtifactNode | null {
  const siblings = nodes
    .filter((node) => node.kind === "audience_package" && node.stage === deck.stage && node.variant === deck.variant && node.supersededByNodeId === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return siblings.find((node) => Date.parse(node.createdAt) <= Date.parse(deck.createdAt)) ?? siblings[0] ?? null;
}

/** Stakeholder names to roles, off the project's policy. */
export function audienceRoles(policy: unknown): ReadonlyMap<string, string> {
  const audiences = ((policy ?? {}) as { audiences?: { name?: unknown; role?: unknown }[] }).audiences ?? [];
  return new Map(audiences.filter((entry) => typeof entry.name === "string").map((entry) => [entry.name as string, typeof entry.role === "string" ? entry.role : ""]));
}

/**
 * Builds the current slides for a recorded deck, as a data URL; null when
 * they cannot be built (no package, no outline), so the caller keeps the
 * recorded file. Errors in drawing fall back the same way.
 */
export function currentDeckBuilder(args: { projectId: string; tenantId: string; projectTitle: string; policy: unknown; nodes: readonly ArtifactNode[] }): (deck: ArtifactNode) => Promise<string | null> {
  const roles = audienceRoles(args.policy);
  const design = args.nodes
    .filter((node) => node.kind === "design_artifact" && node.supersededByNodeId === null)
    .sort((a, b) => b.version - a.version || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  let designHtml: Promise<string | null> | null = null;
  const html = () => {
    designHtml ??= design ? api.artifactContent(args.tenantId, design.id).then((result) => (isHtmlDocument(result.content) ? result.content : null), () => null) : Promise.resolve(null);
    return designHtml;
  };
  const designs = api.deckDesigns().then(
    (loaded) => loaded as Record<string, unknown>,
    () => ({}) as Record<string, unknown>,
  );
  return async (deck) => {
    const pkg = packageOfDeck(args.nodes, deck);
    if (!pkg) return null;
    const audience = deck.variant ?? deck.title;
    const role = roles.get(audience) ?? "";
    try {
      const [markdown, theme, preferences, mockup] = await Promise.all([
        api.artifactContent(args.tenantId, pkg.id).then((result) => result.content),
        role ? api.deckBrief(args.projectId, role).then((loaded) => loaded.theme, () => null) : Promise.resolve(null),
        designs,
        html(),
      ]);
      const built = await buildPackageDeck({
        projectTitle: args.projectTitle,
        audience,
        role,
        markdown,
        design: deckDesignFor(role, preferences),
        ...(theme ? { theme } : {}),
        ...(mockup ? { mockup: { html: mockup, shoot: cachedFramedMockupShots } } : {}),
      });
      return built.dataUrl;
    } catch {
      return null;
    }
  };
}
