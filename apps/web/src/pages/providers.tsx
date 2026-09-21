/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift. One row per way in. A row that is not connected offers exactly one
 * action, named after how it connects; a row that is connected shows what it
 * serves and lets it be refreshed or disconnected in place. Model default,
 * fallback order and restrictions live on the `ResolvedCatalogList` below,
 * which renders the resolved catalog in fallback order.
 *
 * Keys are asked for on the row that was clicked and cleared the moment they
 * are handed over. Nothing here ever renders a secret back.
 *
 * Connecting, refreshing and disconnecting drive the hub's
 * own catalog routes directly (`client.ts` -> `provider-catalog.ts` ->
 * `@solutions-builder/installer`); an OAuth provider signs in through the
 * loopback the embedded hub mounts on `@corbits/oauth-core`
 * (`packages/embed-hub/src/oauth-mount.ts`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, type Provider, type ResolvedCatalogRow } from "../client.js";
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
  /** Settings' connections subsection shows disconnect; onboarding does not. */
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
        // No pin: the workspace default is the priority-first enabled model
        // (CL-8781), derived at read time — nothing to write at connect time.
      } else if (row.kind === "local_endpoint") {
        await api.connectLocalProvider({ baseUrl: baseUrl.trim() || LOCAL_DEFAULT_BASE_URL });
      } else {
        await api.connectProvider({
          providerId: row.id,
          label: row.name,
          apiKey: secret,
          ...(row.needsBaseUrl ? { baseUrl } : {}),
        });
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
          return (
            <li key={row.id} className={`provider-row${asking ? " is-active" : ""}`}>
              <span className="provider-identity">
                <strong>{row.name}</strong>
                <small>
                  {connected
                    ? ready
                      ? describeConnected(connected)
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
                    <details>
                      <summary>Advanced</summary>
                      <div>
                        {/* Model default, fallback order and restrictions live
                            on the resolved catalog above -- this list only
                            attaches and detaches connections. */}
                        <Button
                          variant="ghost"
                          disabled={busy !== null}
                          loading={busy === row.id}
                          onClick={() =>
                            void act(
                              row.id,
                              async () => {
                                await api.refreshProviderModels(connected.id);
                              },
                              `${row.name} models refreshed.`,
                            )
                          }
                        >
                          Refresh models
                        </Button>
                      </div>
                    </details>
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

/** What a connected row says under its name: models on the connection and when it was last checked. */
function describeConnected(provider: Provider): string {
  const parts: string[] = [];
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

/**
 * The resolved catalog (CL-8782): one row per model in fallback order from
 * `GET /api/tenants/:id/models`, with the default, reorder, restrict and
 * shadow controls. Restricted rows stay visible with a badge -- never default
 * candidates. Non-chat rows are badged and can never be the chat default. The
 * credential readout is boolean only; the per-row link jumps to the
 * connections list below. Every write goes through the existing catalog
 * routes; an empty catalog renders an explicit empty state, never simulated
 * rows.
 */
export function ResolvedCatalogList({
  providers,
  onChanged,
}: {
  /** Parent's provider list: a new identity refetches, so connection changes below refresh these rows. */
  providers: Provider[];
  /** Called after any successful change; the parent refetches. */
  onChanged: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<ResolvedCatalogRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await api.resolvedCatalog());
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, providers]);

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await reload();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (rows === null) return <p className="inline-note">Loading models…</p>;

  return (
    <>
      {rows.length === 0 ? (
        <p className="inline-note">
          No models resolved yet. Connect a provider below — the catalog appears here in fallback order.
        </p>
      ) : (
        <ul className="provider-list">
          {rows.map((row, index) => {
            const name = row.displayName ?? row.canonicalName;
            const movable = !row.restricted;
            return (
              <li key={row.modelId} className="provider-row">
                <span className="provider-identity">
                  <strong>{name}</strong>
                  <small>
                    {describeResolvedRow(row, index)}
                  </small>
                </span>
                <span className="provider-state">
                  {row.isDefault ? <StateLabel tone="success">Default</StateLabel> : null}
                  {row.restricted ? <StateLabel tone="warning">Restricted</StateLabel> : null}
                  {row.shadowed ? <StateLabel tone="warning">Shadowed</StateLabel> : null}
                  {!row.chatCapable ? <StateLabel tone="warning">Not chat</StateLabel> : null}
                </span>
                <span className="provider-actions">
                  {row.defaultCandidate && !row.isDefault ? (
                    <Button
                      variant="primary"
                      disabled={busy !== null}
                      loading={busy === `default:${row.modelId}`}
                      onClick={() => void act(`default:${row.modelId}`, () => api.makeResolvedDefault(row.modelId), `${name} is now the default.`)}
                    >
                      Make default
                    </Button>
                  ) : null}
                  {movable ? (
                    <>
                      <Button
                        variant="ghost"
                        disabled={busy !== null || index <= 0}
                        onClick={() => void act(`move:${row.modelId}`, () => api.moveResolvedModel(row.modelId, "up"))}
                      >
                        Move up
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy !== null || index >= rows.length - 1}
                        onClick={() => void act(`move:${row.modelId}`, () => api.moveResolvedModel(row.modelId, "down"))}
                      >
                        Move down
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    loading={busy === `restrict:${row.modelId}`}
                    onClick={() =>
                      void act(
                        `restrict:${row.modelId}`,
                        () => api.setResolvedRestricted(row.modelId, !row.restricted),
                        row.restricted ? `${name} unrestricted.` : `${name} restricted.`,
                      )
                    }
                  >
                    {row.restricted ? "Unrestrict" : "Restrict"}
                  </Button>
                  {row.providerRowIds.length > 0 ? (
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      loading={busy === `shadow:${row.modelId}`}
                      onClick={() =>
                        void act(
                          `shadow:${row.modelId}`,
                          () => api.setResolvedShadowed(row.providerRowIds, !row.shadowed),
                          row.shadowed ? `${name} unshadowed.` : `${name} shadowed.`,
                        )
                      }
                    >
                      {row.shadowed ? "Unshadow" : "Shadow"}
                    </Button>
                  ) : null}
                  <a className="inline-note" href="#connections">
                    {row.credentialConnected ? "Key on file · Manage connection" : "No key · Manage connection"}
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <Banner tone="error" title={error} /> : null}
      {notice ? <Banner tone="okay" title={notice} /> : null}
    </>
  );
}

/** What a resolved row says under its name: fallback rank, serving providers, and model count position. */
export function describeResolvedRow(row: ResolvedCatalogRow, position: number): string {
  const parts: string[] = [];
  if (!row.restricted && row.chatCapable) {
    parts.push(position === 0 ? "Answers first" : `Fallback ${position}`);
  }
  if (row.providerNames.length > 0) parts.push(`via ${row.providerNames.join(", ")}`);
  parts.push(row.canonicalName);
  return parts.join(" · ");
}
