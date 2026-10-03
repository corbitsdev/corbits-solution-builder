/**
 * What a project's stage specialists have actually done, folded from what a
 * browser can read. No producer records which model wrote a turn
 * (`provenance` carries no `model`), so this counts turns, never a cost.
 */
export type ProjectUsage = {
  /** Artifact versions an agent actually wrote. Not a request count, not a token count -- the closest real signal a browser has. */
  turns: number;
};

export function projectUsage(nodes: readonly { provenance: { producer: string } }[]): ProjectUsage {
  return { turns: nodes.filter((node) => node.provenance.producer === "agent").length };
}

/**
 * Turns, labeled as turns -- never dollars. `currentModel` names what is
 * drafting now (`api.activeModel()`); no record ties a past turn to the
 * model that wrote it, so this is offered as context, not attribution.
 */
export function formatUsage(usage: ProjectUsage, currentModel: string | null): string {
  const turnLabel = `${usage.turns} agent turn${usage.turns === 1 ? "" : "s"}`;
  return currentModel ? `${turnLabel} · not priced here · currently drafting with ${currentModel}` : `${turnLabel} · not priced here`;
}
