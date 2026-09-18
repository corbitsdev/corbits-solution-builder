/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift.
 *
 * Connecting, reordering, choosing a model and disconnecting used to be host
 * routes (`POST /providers`, the OAuth loopback, `PUT /providers/order`,
 * `PUT /providers/:id/model`, `DELETE /providers/:id`). The host no longer
 * owns provider mutation (PR #313); this now drives the hub's own catalog
 * routes directly (`client.ts` -> `provider-catalog.ts` -> `@solutions-builder/installer`).
 * An API-key provider gets the full flow: connect, reorder, pick a model,
 * disconnect. An OAuth provider (ChatGPT via Codex, xAI via Grok sign-in)
 * signs in through the loopback the embedded hub itself mounts on
 * `@corbits/oauth-core` (`packages/embed-hub/src/oauth-mount.ts`) -- the hub
 * runs on the same machine as the operator, so it can bind the local
 * callback port a browser client cannot.
 */
import { useState } from "react";
import type { Provider } from "../client.js";
import { api, ApiFailure } from "../client.js";
import { Banner, Button, Field, StateLabel } from "../components.jsx";

export type ApiKeyProvider = { providerId: string; label: string; needsBaseUrl: boolean };
export type OAuthCandidate = { providerId: string; label: string; redirectUri: string };

export function ProviderList({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onChanged,
  manage = false,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  /** Called after any successful change, so the caller can refetch. */
  onChanged?: () => Promise<void> | void;
  manage?: boolean;
}) {
  const candidateLabels = new Map(
    [...oauthCandidates, ...apiKeyProviders].map((entry) => [entry.providerId, entry.label]),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ordered = providers.map((entry) => entry.providerId);

  const withBusy = async (id: string, work: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const move = (index: number, delta: number) => {
    const next = [...providers];
    const at = index + delta;
    if (at < 0 || at >= next.length) return;
    [next[index], next[at]] = [next[at]!, next[index]!];
    return withBusy("order", () => api.reorderProviders(next.map((entry) => entry.id)));
  };

  return (
    <div className="provider-manager">
      {error ? <Banner tone="error" title="That did not go through">{error}</Banner> : null}
      <ul className="provider-list">
        {providers.length === 0 ? (
          <li className="provider-row">
            <span className="provider-identity">
              <small>No provider is connected yet.</small>
            </span>
          </li>
        ) : (
          providers.map((provider, index) => {
            const ready = provider.status === "ready";
            const position = ordered.indexOf(provider.providerId);
            const busy = busyId === provider.id;
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
                {manage ? (
                  <span className="provider-actions">
                    {provider.models.length > 1 ? (
                      <select
                        className="setting-select"
                        aria-label={`Model for ${provider.label}`}
                        value={provider.selectedModel ?? ""}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value || null;
                          void withBusy(provider.id, () => api.selectProviderModel(provider.id, value));
                        }}
                      >
                        <option value="">Let it fail over</option>
                        {provider.models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <Button
                      variant="ghost"
                      disabled={busy || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy || index === providers.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      Move down
                    </Button>
                    <Button
                      variant="destructive"
                      loading={busy}
                      onClick={() => void withBusy(provider.id, () => api.disconnectProvider(provider.id))}
                    >
                      Disconnect
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      <ConnectApiKeyProvider
        candidates={apiKeyProviders.filter((entry) => !ordered.includes(entry.providerId))}
        onConnected={async () => {
          await onChanged?.();
        }}
      />

      <ConnectOAuthProvider
        candidates={oauthCandidates.filter((entry) => !ordered.includes(entry.providerId))}
        onConnected={async () => {
          await onChanged?.();
        }}
      />
    </div>
  );
}

/** One "Sign in" button per unconnected OAuth candidate (ChatGPT via Codex, xAI via Grok). */
function ConnectOAuthProvider({
  candidates,
  onConnected,
}: {
  candidates: OAuthCandidate[];
  onConnected: () => Promise<void>;
}) {
  const [signingInId, setSigningInId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  const signIn = async (candidate: OAuthCandidate) => {
    setSigningInId(candidate.providerId);
    setError(null);
    try {
      await api.connectOAuthProvider({ providerId: candidate.providerId, label: candidate.label });
      await onConnected();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSigningInId(null);
    }
  };

  return (
    <div className="provider-connect">
      {error ? <Banner tone="error" title="Sign-in did not go through">{error}</Banner> : null}
      {candidates.map((candidate) => (
        <Button
          key={candidate.providerId}
          variant="ghost"
          loading={signingInId === candidate.providerId}
          disabled={signingInId !== null && signingInId !== candidate.providerId}
          onClick={() => void signIn(candidate)}
        >
          Sign in to {candidate.label}
        </Button>
      ))}
    </div>
  );
}

/** The connect form: pick a candidate, paste a key, and (for a compatible endpoint) its base URL. */
function ConnectApiKeyProvider({
  candidates,
  onConnected,
}: {
  candidates: ApiKeyProvider[];
  onConnected: () => Promise<void>;
}) {
  const [providerId, setProviderId] = useState(candidates[0]?.providerId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (candidates.length === 0) return null;
  const chosen = candidates.find((entry) => entry.providerId === providerId) ?? candidates[0]!;

  const connect = async () => {
    if (!apiKey.trim()) {
      setError("Paste a key first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.connectProvider({
        providerId: chosen.providerId,
        label: chosen.label,
        apiKey: apiKey.trim(),
        ...(chosen.needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
      });
      setApiKey("");
      setBaseUrl("");
      await onConnected();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-connect">
      {error ? <Banner tone="error" title="Could not connect">{error}</Banner> : null}
      <Field label="Provider">
        <select
          className="setting-select"
          aria-label="Provider to connect"
          value={chosen.providerId}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {candidates.map((entry) => (
            <option key={entry.providerId} value={entry.providerId}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>
      {chosen.needsBaseUrl ? (
        <Field label="Base URL">
          <input
            className="provider-input"
            type="text"
            placeholder="https://example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
      ) : null}
      <Field label="API key">
        <input
          className="provider-input"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>
      <Button loading={busy} onClick={() => void connect()}>
        Connect {chosen.label}
      </Button>
    </div>
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
