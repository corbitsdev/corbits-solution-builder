/**
 * What a project's stage specialists have actually done, and what the
 * workspace has spent on inference, folded from what a browser can read.
 *
 * Per-turn model attribution is never written by any producer in this repo --
 * `packages/tools-delivery/src/publish-workspace.ts:365,388` record
 * `provenance: { producer: "agent", agentRole }` with no `model` field -- so
 * `ArtifactNode.provenance.model` (`apps/web/src/client.ts`) is always unset
 * in practice, not merely untyped. `projectUsage`/`formatUsage` below count
 * turns from that fold, never a cost.
 *
 * A workspace-wide dollar figure now reaches the client through
 * `packages/embed-hub/src/spend.ts`'s `GET /spend`, wired to
 * `EventCollectorRegistry`'s `onUsage` sink (one `TurnUsage` per finished
 * inference turn, with real provider/model/token counts) and priced against
 * the tenant's own `model_pricing` rows. Two honest limits on it, both
 * stated in the UI rather than hidden:
 *
 *  - it is process memory, not a ledger row, so it resets on every hub
 *    restart (`WorkspaceSpend.sinceRestart`);
 *  - it has no per-project breakdown, because this codebase has no mapping
 *    from a workflow run id to the project id the browser knows (main's
 *    project-scoped ledger session has no equivalent here). `formatUsage`
 *    still reports a project's own turn count, unpriced, for that reason.
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
  return currentModel ? `${turnLabel} · not priced here · currently drafting with ${currentModel}` : `${turnLabel} · not priced here`;
}

// --- Workspace spend ----------------------------------------------------------

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number };

export type SpendByProvider = { provider: string; model: string; calls: number; tokens: TokenCounts; cost: number | null };

export type WorkspaceSpend = {
  /** Always true: this is process memory since the hub last started, not a durable ledger. */
  sinceRestart: true;
  rows: SpendByProvider[];
  totals: { calls: number; tokens: TokenCounts; cost: number; currency: string };
  /** Rows whose model has no price on file; their tokens are real but not in `totals.cost`. */
  unpriced: number;
};

const totalTokens = (tokens: TokenCounts): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.thinking;

export const formatTokens = (count: number): string =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(2)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);

export const formatMoney = (amount: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount);

/**
 * The workspace spend headline: money where every observed model has a
 * price, tokens otherwise -- an unpriced model is never folded into a
 * dollar figure, so the total is only ever over what actually has a price.
 */
export function formatSpendHeadline(spend: WorkspaceSpend): { figure: string; caption: string } {
  const priced = spend.rows.some((row) => row.cost !== null);
  const nothing = spend.totals.calls === 0;
  const figure = nothing
    ? formatMoney(0, spend.totals.currency)
    : priced
      ? formatMoney(spend.totals.cost, spend.totals.currency)
      : `${formatTokens(totalTokens(spend.totals.tokens))} tokens`;
  const base = nothing
    ? "spent on inference since this hub last started. Nothing observed yet."
    : priced
      ? "spent on inference since this hub last started"
      : "of inference since this hub last started, unpriced: no connected model has a price on file yet";
  const unpricedNote = spend.unpriced > 0 && priced ? ` · ${spend.unpriced} model${spend.unpriced === 1 ? "" : "s"} without a price, not in the total` : "";
  return { figure, caption: `${base}${unpricedNote} · counted since the hub last started, not a full history` };
}
