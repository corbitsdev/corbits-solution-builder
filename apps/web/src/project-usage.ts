/**
 * What a project's stage specialists have actually done, folded from what a
 * browser can read.
 *
 * No token count and no price reach the client: `projectSpend`/`workspaceSpend`
 * and the platform's pricing table (`vendor/interchange/packages/db/src/pricing.ts`)
 * are read only from inside `apps/hub` (a frozen file allow-list this app adds
 * no route to), and no offering exposed to the browser
 * (`apps/web/src/provider-catalog.ts`) carries a price. Per-turn model
 * attribution is likewise never written by any producer in this repo --
 * `packages/tools-delivery/src/publish-workspace.ts:365,388` record
 * `provenance: { producer: "agent", agentRole }` with no `model` field -- so
 * `ArtifactNode.provenance.model` (`apps/web/src/client.ts`) is always unset
 * in practice, not merely untyped.
 *
 * What IS real: how many artifact versions a stage specialist actually wrote
 * (`provenance.producer === "agent"`), reachable off `ProjectDetail.nodes`
 * and `ProjectInfo`'s own node fold. This counts those as turns -- never a
 * cost, and never attributed to a model no record actually names.
 */
export type ProjectUsage = {
  /** Artifact versions an agent actually wrote. Not a request count, not a token count -- the closest real signal a browser has. */
  turns: number;
};

export function projectUsage(nodes: readonly { provenance: { producer: string } }[]): ProjectUsage {
  return { turns: nodes.filter((node) => node.provenance.producer === "agent").length };
}

export function workspaceUsage(usages: readonly ProjectUsage[]): ProjectUsage {
  return { turns: usages.reduce((sum, usage) => sum + usage.turns, 0) };
}

/**
 * Turns, labeled as turns -- never dollars. `currentModel` names what is
 * drafting now (`api.activeModel()`); no record ties a past turn to the
 * model that wrote it, so this is offered as context, not attribution.
 */
export function formatUsage(usage: ProjectUsage, currentModel: string | null): string {
  const turnLabel = `${usage.turns} agent turn${usage.turns === 1 ? "" : "s"}`;
  return currentModel ? `${turnLabel} · not priced · currently drafting with ${currentModel}` : `${turnLabel} · not priced`;
}
