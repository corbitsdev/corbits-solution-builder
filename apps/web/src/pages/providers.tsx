/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift. One row per way in. A row that is not connected offers exactly one
 * action, named after how it connects; a row that is connected shows what it
 * serves and lets it be reordered, refreshed or disconnected in place.
 *
 * Keys are asked for on the row that was clicked and cleared the moment they
 * are handed over. Nothing here ever renders a secret back.
 *
 * Connecting, reordering, choosing a model and disconnecting drive the hub's
 * own catalog routes directly (`client.ts` -> `provider-catalog.ts` ->
 * `@solutions-builder/installer`); an OAuth provider signs in through the
 * loopback the embedded hub mounts on `@corbits/oauth-core`
 * (`packages/embed-hub/src/oauth-mount.ts`).
 */
import { useRef, useState } from "react";
import { api, ApiFailure, type Provider } from "../client.js";
import { LOCAL_DEFAULT_BASE_URL, LOCAL_PROVIDER_ID } from "../provider-catalog.js";
import { Banner, Button, StateLabel } from "../components.jsx";
import { Dictated } from "../dictation.jsx";

export type ApiKeyProvider = { providerId: string; label: string; needsBaseUrl: boolean };
export type OAuthCandidate = { providerId: string; label: string; redirectUri: string };

type Row = {
  id: string;
  name: string;
  how: string;
  kind: "oauth" | "api_key" | "local_endpoint";
  action: "Log in with subscription" | "Connect API key" | "Connect locally";
  needsBaseUrl: boolean;
};

/**
 * The model a fresh connection should pin: the first served, when nothing
 * is chosen yet. Null means there is nothing to pin — either a choice
 * already exists (an explicit override persists) or no models are served.
 */
export function autoPickModel(provider: { selectedModel: string | null; models: readonly string[] }): string | null {
  if (provider.selectedModel !== null) return null;
  const [first] = provider.models;
  return first ?? null;
}

/**
 * Pin the first served model when nothing is chosen yet; explicit choices
 * persist. `deps` is the `api` singleton in production and a mock in tests —
 * the component delegates with the default, so the call sites below read
 * unchanged.
 */
export async function autoPickProvider(
  provider: Provider,
  deps: Pick<typeof api, "selectProviderModel"> = api,
): Promise<void> {
  const pin = autoPickModel(provider);
  if (pin !== null) await deps.selectProviderModel(provider.id, pin);
}

/**
 * The OAuth handshake returns no provider, and refresh only returns what was
 * cleared — so look the fresh row up before pinning. `deps` defaults to `api`
 * the same way.
 */
export async function autoPick(
  providerId: string,
  deps: Pick<typeof api, "providers" | "selectProviderModel"> = api,
): Promise<void> {
  const fresh = await deps.providers();
  const provider = fresh.providers.find((entry) => entry.providerId === providerId);
  if (provider) await autoPickProvider(provider, deps);
}

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
  /** Called after any successful change; the parent refetches. */
  onChanged: () => Promise<void> | void;
  /** Settings shows order, model choice and disconnect; onboarding does not. */
  manage?: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const cancelledRef = useRef<Set<string>>(new Set());

  const rows: Row[] = [
    ...oauthCandidates.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      how: "Use a subscription you already pay for.",
      kind: "oauth" as const,
      action: "Log in with subscription" as const,
      needsBaseUrl: false,
    })),
    ...apiKeyProviders.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      how: "Kept in the keychain. Never shown again.",
      kind: "api_key" as const,
      action: "Connect API key" as const,
      needsBaseUrl: entry.needsBaseUrl,
    })),
    // Last: the option that needs no account and no key.
    {
      id: LOCAL_PROVIDER_ID,
      name: "Ollama",
      how: "Runs on this machine. No account, no key.",
      kind: "local_endpoint" as const,
      action: "Connect locally" as const,
      needsBaseUrl: true,
    },
  ];

  const connectedFor = (row: Row) => providers.find((provider) => provider.providerId === row.id);

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    cancelledRef.current.delete(id);
    try {
      await work();
      if (cancelledRef.current.has(id)) return;
      if (done) setNotice(done);
      await onChanged();
    } catch (cause) {
      if (cancelledRef.current.has(id)) return;
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!cancelledRef.current.has(id)) setBusy(null);
    }
  };

  const connect = (row: Row) =>
    act(row.id, async () => {
      if (row.kind === "oauth") {
        await api.connectOAuthProvider({ providerId: row.id, label: row.name }, (url) => {
          if (!cancelledRef.current.has(row.id)) setAuthorizeUrl(url);
        });
        await autoPick(row.id);
      } else if (row.kind === "local_endpoint") {
        await autoPickProvider(await api.connectLocalProvider({ baseUrl: baseUrl.trim() || LOCAL_DEFAULT_BASE_URL }));
      } else {
        await autoPickProvider(
          await api.connectProvider({
            providerId: row.id,
            label: row.name,
            apiKey: secret,
            ...(row.needsBaseUrl ? { baseUrl } : {}),
          }),
        );
      }
      setSecret("");
      setBaseUrl("");
      setAuthorizeUrl(null);
      setChosen(null);
    });

  const cancelSignIn = (id: string) => {
    cancelledRef.current.add(id);
    setBusy(null);
    setAuthorizeUrl(null);
    setError(null);
    setNotice(null);
    // Stop the host's callback server too: it holds a fixed loopback port, so
    // leaving it running makes the next attempt fail as "already in use".
    void api.cancelProviderSignIn(id).catch(() => undefined);
  };

  const canSave = (row: Row) => {
    if (busy !== null) return false;
    if (row.kind === "local_endpoint") return baseUrl.trim().length > 0;
    return secret.trim().length > 0 && (!row.needsBaseUrl || baseUrl.trim().length > 0);
  };

  const closeAsk = () => {
    setChosen(null);
    setSecret("");
    setBaseUrl("");
  };

  const ordered = providers.map((entry) => entry.id);
  const move = (modelProviderId: string, by: -1 | 1) => {
    const index = ordered.indexOf(modelProviderId);
    const order = [...ordered];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved!);
    return act(modelProviderId, () => api.reorderProviders(order));
  };

  return (
    <>
      {authorizeUrl ? (
        <Banner title="Finish signing in, in your browser">
          <span className="hash">{authorizeUrl}</span>
        </Banner>
      ) : null}

      <ul className="provider-list">
        {rows.map((row) => {
          const connected = connectedFor(row);
          const ready = connected?.status === "ready";
          const asking = chosen === row.id;
          const waiting = busy === row.id && row.kind === "oauth";
          const position = connected ? ordered.indexOf(connected.id) : -1;
          return (
            <li key={row.id} className={`provider-row${asking ? " is-active" : ""}`}>
              <span className="provider-identity">
                <strong>{row.name}</strong>
                <small>
                  {connected
                    ? ready
                      ? describeConnected(connected, manage ? position : -1)
                      : (connected.statusDetail ?? connected.status)
                    : row.how}
                </small>
              </span>

              {asking ? (
                <form
                  className="provider-ask"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canSave(row)) void connect(row);
                  }}
                >
                  {row.needsBaseUrl ? (
                    <Dictated value={baseUrl} onValueChange={setBaseUrl} align="center">
                      <input
                        className="provider-input"
                        type="text"
                        autoFocus={row.kind === "local_endpoint"}
                        placeholder={row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "https://example.com/v1"}
                        aria-label="Endpoint"
                        autoComplete="off"
                        spellCheck={false}
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            closeAsk();
                          }
                        }}
                      />
                    </Dictated>
                  ) : null}
                  {row.kind === "api_key" ? (
                    <input
                      className="provider-input"
                      type="password"
                      autoFocus={!row.needsBaseUrl}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      placeholder={`${row.name} API key`}
                      aria-label={`${row.name} API key`}
                      autoComplete="off"
                      spellCheck={false}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          closeAsk();
                        }
                      }}
                    />
                  ) : null}
                  <Button type="submit" variant="primary" loading={busy === row.id} disabled={!canSave(row)}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={closeAsk}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <span className="provider-state">
                  {connected ? (
                    <StateLabel tone={ready ? "success" : "warning"}>
                      {ready ? "Connected" : "Needs attention"}
                    </StateLabel>
                  ) : waiting ? (
                    <StateLabel tone="loading">Waiting for the browser</StateLabel>
                  ) : null}
                </span>
              )}

              {asking ? null : (
                <span className="provider-actions">
                  {manage && connected && ready ? (
                    <>
                      <ModelPick provider={connected} onPick={(model) => act(row.id, () => api.selectProviderModel(connected.id, model || null))} />
                      <details>
                        <summary>Advanced</summary>
                        <div>
                          {connected.models.length > 1 ? (
                            connected.selectedModel !== null ? (
                              <Button
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() => void act(row.id, () => api.selectProviderModel(connected.id, null))}
                              >
                                Let it fail over
                              </Button>
                            ) : (
                              <span className="inline-note">Failing over in order.</span>
                            )
                          ) : null}
                          <Button
                            variant="ghost"
                            disabled={busy !== null || position <= 0}
                            onClick={() => void move(connected.id, -1)}
                          >
                            Move up
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy !== null || position < 0 || position === ordered.length - 1}
                            onClick={() => void move(connected.id, 1)}
                          >
                            Move down
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy !== null}
                            loading={busy === row.id}
                            onClick={() =>
                              void act(
                                row.id,
                                async () => {
                                  await api.refreshProviderModels(connected.id);
                                  await autoPick(connected.providerId);
                                },
                                `${row.name} models refreshed.`,
                              )
                            }
                          >
                            Refresh models
                          </Button>
                        </div>
                      </details>
                    </>
                  ) : null}
                  {waiting ? (
                    <Button variant="ghost" onClick={() => cancelSignIn(row.id)}>
                      Cancel
                    </Button>
                  ) : connected && manage ? (
                    <Button
                      variant="destructive"
                      disabled={busy !== null}
                      loading={busy === row.id}
                      onClick={() => void act(row.id, () => api.disconnectProvider(connected.id), `${row.name} disconnected.`)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant={connected ? "ghost" : "primary"}
                      loading={busy === row.id}
                      disabled={busy !== null}
                      onClick={() => {
                        if (row.kind === "oauth") void connect(row);
                        else {
                          setChosen(row.id);
                          setSecret("");
                          setBaseUrl(row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "");
                        }
                      }}
                    >
                      {connected ? "Reconnect" : row.action}
                    </Button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Below the list, always. An error above it would move the thing the
          person was about to click. */}
      {error ? <Banner tone="error" title={error} /> : null}
      {notice ? <Banner tone="okay" title={notice} /> : null}

      {rows.find((row) => row.id === chosen)?.kind === "local_endpoint" ? (
        <p className="inline-note">
          Ollama's default. Change it for LM Studio, vLLM or another OpenAI-compatible server.
        </p>
      ) : null}
    </>
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

function ModelPick({ provider, onPick }: { provider: Provider; onPick: (model: string) => void }) {
  const [first] = provider.models;
  if (!first) return null;
  const value = provider.selectedModel && provider.models.includes(provider.selectedModel) ? provider.selectedModel : first;
  return (
    <label className="provider-model">
      <span className="sr-only">Model for {provider.label}</span>
      <select className="setting-select" value={value} onChange={(event) => onPick(event.target.value)}>
        {provider.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </label>
  );
}
