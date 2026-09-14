/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift. One row per way in. A row that is not connected offers exactly one
 * action, named after how it connects; a row that is connected shows what it
 * serves and lets it be reordered, refreshed or disconnected in place.
 *
 * Keys are asked for on the row that was clicked and cleared the moment they
 * are handed over. Nothing here ever renders a secret back.
 */
import { Input } from "@corbits/react-ui";
import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api, ApiFailure, OLLAMA_BASE_URL, type Provider } from "../client.js";
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
};

const LOCAL_ID = "local";

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
  const [baseUrl, setBaseUrl] = useState(OLLAMA_BASE_URL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const rows: Row[] = [
    ...oauthCandidates.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      how: "Use a subscription you already pay for.",
      kind: "oauth" as const,
      action: "Log in with subscription" as const,
    })),
    ...apiKeyProviders
      .filter((entry) => !entry.needsBaseUrl)
      .map((entry) => ({
        id: entry.providerId,
        name: entry.label,
        how: "Kept in the keychain. Never shown again.",
        kind: "api_key" as const,
        action: "Connect API key" as const,
      })),
    // Last: the option that needs no account and no key.
    {
      id: LOCAL_ID,
      name: "Ollama",
      how: "Runs on this machine. No account, no key.",
      kind: "local_endpoint",
      action: "Connect locally",
    },
  ];

  const connectedFor = (row: Row) =>
    providers.find((provider) => provider.providerId === row.id);

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await work();
      // Bindings follow credentials: the install is idempotent and cheap, so
      // any change to what is connected re-runs it.
      void api.install().catch((cause) => {
        setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
      if (done) setNotice(done);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const connect = (row: Row) =>
    act(row.id, async () => {
      if (row.kind === "oauth") {
        // Two calls on purpose: starting returns the authorize URL so a failed
        // browser launch is recoverable by copying the link; finishing waits
        // on the loopback callback.
        const started = await api.startOAuth(row.id);
        setAuthorizeUrl(started.browserOpened ? null : started.authorizeUrl);
        await api.finishOAuth();
      } else {
        await api.connectProvider({
          kind: row.kind,
          providerId: row.kind === "local_endpoint" ? LOCAL_ID : row.id,
          label: row.name,
          ...(row.kind === "api_key" ? { secret } : { baseUrl }),
        });
        setSecret("");
      }
      setAuthorizeUrl(null);
      setChosen(null);
    });

  const cancelSignIn = async () => {
    await api.cancelOAuth();
    setBusy(null);
    setAuthorizeUrl(null);
  };

  const canSave = (row: Row) =>
    busy === null &&
    (row.kind === "api_key" ? secret.trim().length > 0 : baseUrl.trim().length > 0);

  const closeAsk = () => {
    setChosen(null);
    setSecret("");
  };

  const ordered = providers.map((entry) => entry.providerId);
  const move = (providerId: string, by: -1 | 1) => {
    const index = ordered.indexOf(providerId);
    const order = [...ordered];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved!);
    return act(providerId, () => api.setProviderOrder(order));
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
          const position = connected ? ordered.indexOf(connected.providerId) : -1;
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
                  {(() => {
                    const field = (
                      <Input
                        autoFocus
                        type={row.kind === "api_key" ? "password" : "text"}
                        value={row.kind === "api_key" ? secret : baseUrl}
                        onChange={(event) =>
                          row.kind === "api_key"
                            ? setSecret(event.target.value)
                            : setBaseUrl(event.target.value)
                        }
                        placeholder={row.kind === "api_key" ? `${row.name} API key` : "Endpoint"}
                        aria-label={row.kind === "api_key" ? `${row.name} API key` : "Endpoint"}
                        autoComplete="off"
                        spellCheck={false}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            closeAsk();
                          }
                        }}
                      />
                    );
                    // A key is a secret that is pasted, not said; an endpoint is an address.
                    return row.kind === "api_key" ? (
                      field
                    ) : (
                      <Dictated value={baseUrl} onValueChange={setBaseUrl} align="center">
                        {field}
                      </Dictated>
                    );
                  })()}
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
                      <ModelPick provider={connected} onPick={(model) => act(row.id, () => api.selectModel(connected.providerId, model))} />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${row.name} up`}
                        disabled={busy !== null || position <= 0}
                        onClick={() => void move(connected.providerId, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${row.name} down`}
                        disabled={busy !== null || position < 0 || position === ordered.length - 1}
                        onClick={() => void move(connected.providerId, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Refresh models for ${row.name}`}
                        disabled={busy !== null}
                        onClick={() =>
                          void act(row.id, () => api.refreshModels(connected.providerId), `${row.name} models refreshed.`)
                        }
                      >
                        <RefreshCw aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  {waiting ? (
                    <Button onClick={() => void cancelSignIn()}>Cancel</Button>
                  ) : connected && manage ? (
                    <Button
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(row.id, () => api.disconnectProvider(connected.providerId), `${row.name} disconnected.`)}
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
                        else setChosen(row.id);
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
          Ollama's default. Change it on the row for LM Studio, vLLM or another
          OpenAI-compatible server.
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
  return (
    <label className="provider-model">
      <span className="sr-only">Model for {provider.label}</span>
      <select value={provider.selectedModel ?? ""} onChange={(event) => onPick(event.target.value)}>
        <option value="">Best available</option>
        {provider.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </label>
  );
}
