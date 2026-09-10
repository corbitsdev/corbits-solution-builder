/**
 * Settings: three things a person can actually change.
 *
 *   1. Inference — which providers answer, in what order, with which model.
 *   2. This computer — whether the host starts at login, and stopping it.
 *   3. Diagnostics — folded away; for when something is wrong.
 *
 * The secret rule shows up in the markup: a key field is cleared the moment it
 * is handed over, and nothing ever renders it back. What the UI sees is a
 * status and a boolean.
 */
import { Input, Switch, Tabs } from "@corbits/react-ui";
import { ArrowDown, ArrowUp, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiFailure, type HostStatus, type Provider } from "../client.js";
import { Banner, Button, Field, StateLabel } from "../components.jsx";

type ApiKeyProvider = { providerId: string; label: string; needsBaseUrl: boolean };
type OAuthCandidate = { providerId: string; label: string; redirectUri: string };

export function Settings({
  status,
  providers,
  apiKeyProviders,
  oauthCandidates,
  onChanged,
}: {
  status: HostStatus | null;
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onChanged: () => void;
}) {
  return (
    <div className="settings">
      <Inference
        status={status}
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onChanged}
      />
      <ThisComputer status={status} />
      <Diagnostics status={status} />
    </div>
  );
}

function Section({
  title,
  lead,
  status,
  children,
}: {
  title: string;
  lead?: string;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <header className="settings-head">
        <div>
          <h2>{title}</h2>
          {lead ? <p>{lead}</p> : null}
        </div>
        {status}
      </header>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- inference */

function Inference({
  status,
  providers,
  apiKeyProviders,
  oauthCandidates,
  onChanged,
}: {
  status: HostStatus | null;
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = providers.find((provider) => provider.active) ?? providers[0];

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await work();
      if (done) setNotice(done);
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  const move = (index: number, by: -1 | 1) => {
    const order = providers.map((entry) => entry.providerId);
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved!);
    return act(() => api.setProviderOrder(order));
  };

  return (
    <Section
      title="Inference"
      lead="The models that draft every stage. Providers are tried top to bottom; if the first cannot answer, the next one does, and each version records who wrote it."
      status={
        status?.inference.connected && active ? (
          <StateLabel tone="success">Connected · {active.label}</StateLabel>
        ) : (
          <StateLabel tone="warning">Nothing connected</StateLabel>
        )
      }
    >
      {error ? <Banner tone="error" title={error} /> : null}
      {notice ? <Banner tone="okay" title={notice} /> : null}

      {providers.length > 0 ? (
        <ol className="provider-list">
          {providers.map((provider, index) => (
            <li key={provider.id} className="provider-row">
              <span className="provider-order">{index + 1}</span>
              <div className="provider-name">
                <strong>{provider.label}</strong>
                <span>
                  {provider.status === "ready" ? (
                    index === 0 ? "Answers first" : `Fallback ${index}`
                  ) : (
                    <span className="provider-problem">{provider.statusDetail ?? provider.status}</span>
                  )}
                </span>
              </div>
              <label className="provider-model">
                <span className="sr-only">Model for {provider.label}</span>
                <select
                  value={provider.selectedModel ?? ""}
                  onChange={(event) =>
                    void act(() => api.selectModel(provider.providerId, event.target.value))
                  }
                >
                  <option value="">Best available</option>
                  {provider.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <span className="provider-model-count">
                  {provider.models.length} model{provider.models.length === 1 ? "" : "s"}
                </span>
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${provider.label} up`}
                  disabled={index === 0}
                  onClick={() => void move(index, -1)}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move ${provider.label} down`}
                  disabled={index === providers.length - 1}
                  onClick={() => void move(index, 1)}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Refresh models for ${provider.label}`}
                  onClick={() =>
                    void act(() => api.refreshModels(provider.providerId), `${provider.label} catalog refreshed.`)
                  }
                >
                  <RefreshCw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Disconnect ${provider.label}`}
                  onClick={() => void act(() => api.disconnectProvider(provider.providerId))}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="settings-empty">No provider yet. Add one below and every stage can start.</p>
      )}

      <AddProvider
        connected={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        keychain={status?.credentialBackend === "keychain"}
        onDone={(message) => {
          setNotice(message);
          setError(null);
          onChanged();
        }}
        onError={setError}
      />
    </Section>
  );
}

function AddProvider({
  connected,
  apiKeyProviders,
  oauthCandidates,
  keychain,
  onDone,
  onError,
}: {
  connected: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  keychain: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [way, setWay] = useState<"key" | "account" | "local">("key");
  const [providerId, setProviderId] = useState(apiKeyProviders[0]?.providerId ?? "anthropic");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [busy, setBusy] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const chosen = apiKeyProviders.find((entry) => entry.providerId === providerId);

  const connectKey = async () => {
    setBusy("key");
    try {
      await api.connectProvider({
        kind: "api_key",
        providerId,
        label: chosen?.label ?? providerId,
        secret,
        ...(chosen?.needsBaseUrl ? { baseUrl } : {}),
      });
      // Cleared immediately after the secure handoff, and never rendered back.
      setSecret("");
      onDone(`${chosen?.label ?? providerId} connected.`);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectLocal = async () => {
    setBusy("local");
    try {
      await api.connectProvider({ kind: "local_endpoint", providerId: "local", label: "Local endpoint", baseUrl });
      onDone("Local endpoint connected.");
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  // Two calls on purpose: starting returns the authorize URL so a failed
  // browser launch is recoverable by copying the link; finishing waits on the
  // loopback callback. Cancelling closes that server so a late redirect cannot
  // resurrect a session the person walked away from.
  const signIn = async (candidate: OAuthCandidate) => {
    setBusy(candidate.providerId);
    setAuthorizeUrl(null);
    try {
      const started = await api.startOAuth(candidate.providerId);
      setAuthorizeUrl(started.authorizeUrl);
      const finished = await api.finishOAuth();
      setAuthorizeUrl(null);
      onDone(`Signed in to ${finished.provider.label}.`);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="add-provider">
      <h3>Add a provider</h3>
      <Tabs
        label="How to connect"
        variant="enclosed"
        active={way}
        onChange={(id) => setWay(id as typeof way)}
        tabs={[
          { id: "key", label: "API key" },
          { id: "account", label: "Sign in" },
          { id: "local", label: "Local model" },
        ]}
      >
        {(id) =>
          id === "key" ? (
            <div className="add-provider-form">
              <Field label="Provider">
                <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                  {apiKeyProviders.map((entry) => (
                    <option key={entry.providerId} value={entry.providerId}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
              {chosen?.needsBaseUrl ? (
                <Field label="Base URL">
                  <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
                </Field>
              ) : null}
              <Field
                label="API key"
                helper={keychain ? "Kept in the macOS keychain. Never shown again." : "Kept in a private file. Never shown again."}
              >
                <Input
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="button-row">
                <Button variant="primary" loading={busy === "key"} disabled={secret.length === 0} onClick={connectKey}>
                  Connect
                </Button>
              </div>
            </div>
          ) : id === "account" ? (
            <div className="add-provider-form">
              <p className="settings-note">
                Use a subscription you already pay for. The host holds the token; nothing is typed here.
              </p>
              <div className="account-list">
                {oauthCandidates.map((candidate) => {
                  const signed = connected.some((provider) => provider.providerId === candidate.providerId);
                  const waiting = busy === candidate.providerId;
                  return (
                    <div key={candidate.providerId} className="account-row">
                      <strong>{candidate.label}</strong>
                      {signed ? (
                        <StateLabel tone="success">Signed in</StateLabel>
                      ) : waiting ? (
                        <StateLabel tone="loading">Waiting for the browser</StateLabel>
                      ) : null}
                      <span className="account-actions">
                        {waiting ? (
                          <Button
                            onClick={async () => {
                              await api.cancelOAuth();
                              setBusy(null);
                              setAuthorizeUrl(null);
                            }}
                          >
                            Cancel
                          </Button>
                        ) : signed ? (
                          <Button onClick={() => void api.disconnectProvider(candidate.providerId).then(() => onDone(`Signed out of ${candidate.label}.`))}>
                            Sign out
                          </Button>
                        ) : (
                          <Button variant="primary" disabled={busy !== null} onClick={() => void signIn(candidate)}>
                            Sign in
                          </Button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {authorizeUrl ? (
                <Banner title="Finish in your browser">
                  <span className="hash">{authorizeUrl}</span>
                </Banner>
              ) : null}
            </div>
          ) : (
            <div className="add-provider-form">
              <p className="settings-note">Ollama or anything that speaks its API. Runs on this machine; nothing leaves it.</p>
              <Field label="Address">
                <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </Field>
              <div className="button-row">
                <Button variant="primary" loading={busy === "local"} disabled={baseUrl.length === 0} onClick={connectLocal}>
                  Connect
                </Button>
              </div>
            </div>
          )
        }
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------ this computer */

/**
 * Start-at-login is off until somebody turns it on, the copy says what it does
 * and does not do, and it says when the change takes effect rather than
 * implying it is already true.
 */
function ThisComputer({ status }: { status: HostStatus | null }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .preferences()
      .then((result) => {
        if (!cancelled) setEnabled(result.preferences["host.startAtLogin"] === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setError(null);
    setEnabled(next);
    try {
      await api.setPreference("host.startAtLogin", next);
    } catch (cause) {
      setEnabled(!next);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section title="This computer" lead="The host does the work. This window is only how you watch it.">
      {error ? <Banner tone="error" title={error} /> : null}
      <div className="setting-row">
        <div>
          <strong>Start when you log in</strong>
          <p>Keeps projects moving between the times you open this window. Applies from your next login. Never runs while the machine is asleep.</p>
        </div>
        <Switch
          label="Start when you log in"
          checked={enabled ?? false}
          disabled={enabled === null}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Stop the host</strong>
          <p>Closing the window only disconnects it. This ends the host, and everything in progress pauses until it starts again.</p>
        </div>
        <Button variant="destructive" onClick={() => void api.stopHost()}>
          Stop
        </Button>
      </div>
      {status ? (
        <p className="settings-note">
          Keys are kept {status.credentialBackend === "keychain" ? "in the macOS keychain" : "in a private file on disk"}.
        </p>
      ) : null}
    </Section>
  );
}

/* -------------------------------------------------------------- diagnostics */

function Diagnostics({ status }: { status: HostStatus | null }) {
  if (!status) return null;
  const capabilities = Object.entries(status.build.capabilities);
  return (
    <details className="settings-diagnostics">
      <summary>Diagnostics</summary>
      <dl className="diagnostic-list">
        <div>
          <dt>Host</dt>
          <dd>
            {status.host.state} · pid {status.host.pid} · since {new Date(status.host.startedAt).toLocaleString()}
          </dd>
        </div>
        {status.host.sleepGaps.length > 0 ? (
          <div>
            <dt>Not running</dt>
            <dd>
              {status.host.sleepGaps
                .map(
                  (gap) =>
                    `${new Date(gap.from).toLocaleTimeString()}–${new Date(gap.to).toLocaleTimeString()} (${gap.seconds}s)`,
                )
                .join("; ")}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Hub</dt>
          <dd>
            {status.hub.ready ? (status.hub.mode === "embedded" ? "Embedded, in this app" : `Hosted at ${status.hub.url}`) : `Unavailable: ${status.hub.detail}`}
          </dd>
        </div>
        <div>
          <dt>Build worker</dt>
          <dd>
            {status.build.detail} ({capabilities.filter(([, ok]) => ok).length} of {capabilities.length} controls)
          </dd>
        </div>
      </dl>
    </details>
  );
}
