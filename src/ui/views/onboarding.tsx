/**
 * Onboarding — the guided path into the product.
 *
 * Two steps, one decision each, on a full screen with no navigation rail:
 * connect inference, then describe the first problem. Nothing else is offered
 * until both are done, so there is nothing to get lost in.
 *
 * Policy (cost tolerance, audiences, quorum) is not asked here. Somebody
 * arriving with a half-formed problem does not yet know what their cost
 * tolerance is, and asking is how a first run stalls. Sensible defaults apply
 * and Settings can change them before any review begins.
 */
import { Input, Textarea } from "@corbits/react-ui";
import { useState } from "react";
import { api, ApiFailure, OLLAMA_BASE_URL, type Provider } from "../client.js";
import { Banner, Button, Mark, StateLabel } from "../components.jsx";

type Step = "provider" | "project";

export function Onboarding({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onConnected,
  onCreated,
}: {
  providers: Provider[];
  apiKeyProviders: { providerId: string; label: string; needsBaseUrl: boolean }[];
  oauthCandidates: { providerId: string; label: string; redirectUri: string }[];
  onConnected: () => Promise<void>;
  onCreated: (projectId: string) => void;
}) {
  const connected = providers.some((provider) => provider.status === "ready");
  const [step, setStep] = useState<Step>(connected ? "project" : "provider");
  // Named rather than compared inline: a class list should read as class
  // names, and a comparison operand sitting in one reads as a class that has
  // no rule.
  const onProjectStep = step === "project";

  return (
    <div className="onboarding">
      <div className="onboarding-brand">
        <Mark size={26} />
        <strong>Solutions Builder</strong>
      </div>

      <div className="onboarding-card">
        <div className="step-track" aria-label={`Step ${step === "provider" ? 1 : 2} of 2`}>
          <span className="step-label">Step {step === "provider" ? 1 : 2} of 2</span>
          <span className="active" />
          <span className={onProjectStep ? "active" : ""} />
        </div>

        {step === "provider" ? (
          <ProviderStep
            providers={providers}
            apiKeyProviders={apiKeyProviders}
            oauthCandidates={oauthCandidates}
            onConnected={async () => {
              await onConnected();
              setStep("project");
            }}
          />
        ) : (
          <ProjectStep onCreated={onCreated} />
        )}
      </div>

      <p className="onboarding-foot">
        <Mark size={14} />
        <span>Powered by Corbits</span>
      </p>
    </div>
  );
}

/** Step 1: one row per way in, each with a single action. */
function ProviderStep({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onConnected,
}: {
  providers: Provider[];
  apiKeyProviders: { providerId: string; label: string; needsBaseUrl: boolean }[];
  oauthCandidates: { providerId: string; label: string; redirectUri: string }[];
  onConnected: () => Promise<void>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState(OLLAMA_BASE_URL);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const isConnected = (id: string) =>
    providers.some((provider) => provider.providerId === id && provider.status === "ready");

  const rows = [
    ...oauthCandidates.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      method: "Sign in with your account",
      kind: "oauth" as const,
    })),
    ...apiKeyProviders
      .filter((entry) => !entry.needsBaseUrl)
      .map((entry) => ({
        id: entry.providerId,
        name: entry.label,
        method: "API key",
        kind: "api_key" as const,
      })),
    // Last: the option that needs no account and no key. It is the shortest
    // path from nothing to a working app, and its endpoint is prefilled, but it
    // is also the one a person reaches for after ruling the others out.
    {
      id: "local",
      name: "Ollama",
      method: "Runs on this machine. No account, no key.",
      kind: "local_endpoint" as const,
    },
  ];

  /** Whether the row has what it needs to be connected. */
  const canConnect = (row: (typeof rows)[number]) =>
    busy === null &&
    (row.kind === "api_key" ? secret.trim().length > 0 : baseUrl.trim().length > 0);

  const connect = async (row: (typeof rows)[number]) => {
    setBusy(row.id);
    setError(null);
    try {
      if (row.kind === "oauth") {
        const started = await api.startOAuth(row.id);
        setAuthorizeUrl(started.browserOpened ? null : started.authorizeUrl);
        await api.finishOAuth();
      } else {
        await api.connectProvider({
          kind: row.kind,
          providerId: row.kind === "local_endpoint" ? "local" : row.id,
          label: row.name,
          ...(row.kind === "api_key" ? { secret } : { baseUrl }),
        });
        setSecret("");
      }
      setAuthorizeUrl(null);
      await onConnected();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const selected = rows.find((row) => row.id === chosen);

  return (
    <>
      <h1>Connect a model.</h1>
      <p className="lede">
        Specialists draft with it. You approve everything they produce.
      </p>

      {authorizeUrl ? (
        <Banner title="Finish signing in, in your browser">
          <span className="hash">{authorizeUrl}</span>
        </Banner>
      ) : null}

      <ul className="provider-list">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`provider-row${chosen === row.id ? " is-active" : ""}`}
          >
            <span className="provider-identity">
              <strong>{row.name}</strong>
              <small>{row.method}</small>
            </span>

            {/* Asking on the row that was clicked. A field further down the
                page is a second place to look for the answer to a question
                asked up here, and the distance is the whole problem. */}
            {chosen === row.id && row.kind !== "oauth" ? (
              <form
                className="provider-ask"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canConnect(row)) void connect(row);
                }}
              >
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
                      setChosen(null);
                      setSecret("");
                    }
                  }}
                />
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === row.id}
                  disabled={!canConnect(row)}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setChosen(null);
                    setSecret("");
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                {isConnected(row.id) ? (
                  <StateLabel tone="success">Connected</StateLabel>
                ) : (
                  <span />
                )}
                <Button
                  loading={busy === row.id}
                  disabled={busy !== null}
                  onClick={() => {
                    if (row.kind === "oauth") void connect(row);
                    else setChosen(chosen === row.id ? null : row.id);
                  }}
                >
                  {isConnected(row.id)
                    ? "Reconnect"
                    : row.kind === "oauth"
                      ? "Sign in"
                      : "Connect"}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>

      {/* Below the list, always. An error above it would push every option
          down the moment something failed, moving the thing the person was
          about to click. */}
      {error ? <Banner tone="error" title={error} /> : null}

      {/* Ollama needs no key, so its endpoint is the one thing still worth a
          note under the list rather than squeezed onto the row. */}
      {selected?.kind === "local_endpoint" ? (
        <p className="inline-note">
          Ollama's default. Change it on the row for LM Studio, vLLM or another
          OpenAI-compatible server.
        </p>
      ) : null}

    </>
  );
}

/** Step 2: the only question worth asking first. */
function ProjectStep({ onCreated }: { onCreated: (projectId: string) => void }) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({
        problemStatement: problem.trim(),
        policy: DEFAULT_POLICY,
      });
      onCreated(created.projectId);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <>
      <h1>What problem are you trying to solve?</h1>
      <p className="lede">
        Describe it however it comes out. Scoping it is the first stage.
      </p>

      {error ? <Banner tone="error" title={error} /> : null}

      <div className="ask">
        <Textarea
          id="first-problem"
          value={problem}
          onChange={(event) => setProblem(event.target.value)}
          placeholder="Something that keeps costing me time, and I have never sat down to fix it properly…"
          autoFocus
        />
        <Button
          variant="primary"
          block
          loading={busy}
          disabled={problem.trim().length < 10}
          onClick={() => void create()}
        >
          Begin problem discovery
        </Button>
      </div>
    </>
  );
}

/**
 * Defaults for a new project. Changeable in Settings before any review begins;
 * asking a first-time user for a cost tolerance is how a first run stalls.
 */
export const DEFAULT_POLICY = {
  costTolerancePercent: 15,
  costToleranceAbsolute: 500,
  audiences: [{ name: "You", role: "project_owner" as const }],
  audienceQuorum: 1,
  allowExternalProviders: true,
};
