/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift. Read-only: it shows what the hub catalog already has connected.
 *
 * Connecting, reordering, choosing a model and disconnecting used to be host
 * routes (`POST /providers`, the OAuth loopback, `PUT /providers/order`,
 * `PUT /providers/:id/model`, `DELETE /providers/:id`). The host no longer
 * owns provider mutation, and the hub has no client-driven equivalent for it
 * yet -- connecting needs live validation against the provider (or a bound
 * loopback port, for OAuth) that nothing on the client side does today. Until
 * that lands as a real hub-backed flow, this only lists what is already
 * connected; nothing here can connect, reorder, choose a model for, or
 * disconnect a provider.
 */
import type { Provider } from "../client.js";
import { StateLabel } from "../components.jsx";

export type ApiKeyProvider = { providerId: string; label: string; needsBaseUrl: boolean };
export type OAuthCandidate = { providerId: string; label: string; redirectUri: string };

export function ProviderList({
  providers,
  apiKeyProviders,
  oauthCandidates,
  manage = false,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  /** Called after any successful change; unused now that this is read-only. */
  onChanged?: () => Promise<void> | void;
  manage?: boolean;
}) {
  const candidateLabels = new Map(
    [...oauthCandidates, ...apiKeyProviders].map((entry) => [entry.providerId, entry.label]),
  );

  const ordered = providers.map((entry) => entry.providerId);

  return (
    <ul className="provider-list">
      {providers.length === 0 ? (
        <li className="provider-row">
          <span className="provider-identity">
            <small>No provider is connected yet.</small>
          </span>
        </li>
      ) : (
        providers.map((provider) => {
          const ready = provider.status === "ready";
          const position = ordered.indexOf(provider.providerId);
          return (
            <li key={provider.providerId} className="provider-row">
              <span className="provider-identity">
                <strong>{candidateLabels.get(provider.providerId) ?? provider.label}</strong>
                <small>
                  {ready
                    ? describeConnected(provider, manage ? position : -1)
                    : (provider.statusDetail ?? provider.status)}
                </small>
              </span>
              <span className="provider-state">
                <StateLabel tone={ready ? "success" : "warning"}>
                  {ready ? "Connected" : "Needs attention"}
                </StateLabel>
              </span>
            </li>
          );
        })
      )}
    </ul>
  );
}

/** What a connected row says under its name: order, models, and when it was last checked. */
function describeConnected(provider: Provider, position: number): string {
  const parts: string[] = [];
  if (position === 0) parts.push("Answers first");
  else if (position > 0) parts.push(`Fallback ${position}`);
  parts.push(`${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`);
  if (provider.validatedAt) parts.push(`checked ${ago(provider.validatedAt)}`);
  return parts.join(" · ");
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
