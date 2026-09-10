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
import { Switch } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, ApiFailure, type HostStatus, type Provider } from "../client.js";
import { Banner, Button, StateLabel } from "../components.jsx";
import { ProviderList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";

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
  const active = providers.find((provider) => provider.active) ?? providers[0];
  return (
    <Section
      title="Inference"
      lead="The models that draft every stage. Connected providers are tried top to bottom; if the first cannot answer, the next one does, and each version records who wrote it."
      status={
        status?.inference.connected && active ? (
          <StateLabel tone="success">Connected · {active.label}</StateLabel>
        ) : (
          <StateLabel tone="warning">Nothing connected</StateLabel>
        )
      }
    >
      <ProviderList
        manage
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onChanged}
      />
    </Section>
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
