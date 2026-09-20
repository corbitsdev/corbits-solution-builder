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
import { Textarea } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, ApiFailure, type Provider } from "../client.js";
import { Banner, Button, Mark } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { ProviderList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";

type Step = "provider" | "model" | "project";

export function Onboarding({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onConnected,
  onCreated,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onConnected: () => Promise<void>;
  onCreated: (projectId: string) => void;
}) {
  const connected = providers.some((provider) => provider.status === "ready");
  const [step, setStep] = useState<Step>(connected ? "project" : "provider");
  // Set right after a connect, before the refreshed `providers` prop lands --
  // the effect below picks the next step once it does, rather than this
  // component guessing from the stale list it already has.
  const [awaitingChoice, setAwaitingChoice] = useState(false);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (!awaitingChoice) return;
    setAwaitingChoice(false);
    const pending = providers.find(
      (provider) => provider.status === "ready" && provider.models.length > 1 && provider.selectedModel === null,
    );
    if (pending) {
      setModelProviderId(pending.id);
      setStep("model");
    } else {
      setStep("project");
    }
  }, [providers, awaitingChoice]);

  const modelProvider = providers.find((provider) => provider.id === modelProviderId) ?? null;
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
        <div className="step-track" aria-label={`Step ${onProjectStep ? 2 : 1} of 2`}>
          <span className="step-label">Step {onProjectStep ? 2 : 1} of 2</span>
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
              setAwaitingChoice(true);
            }}
          />
        ) : step === "model" && modelProvider ? (
          <ModelStep provider={modelProvider} onChosen={() => setStep("project")} />
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

/** Step 1: the shared provider list, with an intro. */
function ProviderStep({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onConnected,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onConnected: () => Promise<void>;
}) {
  return (
    <>
      <h1>Connect a model.</h1>
      <p className="lede">
        Specialists draft with it. You approve everything they produce.
      </p>
      <ProviderList
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onConnected}
      />
    </>
  );
}

/**
 * Shown only when the provider just connected serves more than one model --
 * otherwise the specialists would silently draft with whichever the endpoint
 * happened to list first. Reuses `api.selectProviderModel`, the same call
 * Settings' provider manager makes.
 */
function ModelStep({ provider, onChosen }: { provider: Provider; onChosen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (canonicalName: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.selectProviderModel(provider.id, canonicalName);
      onChosen();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Which model should {provider.label} draft with?</h1>
      <p className="lede">
        It serves {provider.models.length} models. Pick the one specialists should use, or let it fail over between them.
      </p>

      {error ? <Banner tone="error" title={error} /> : null}

      <div className="ask">
        <select
          className="setting-select"
          aria-label={`Model for ${provider.label}`}
          disabled={busy}
          defaultValue=""
          onChange={(event) => void choose(event.target.value || null)}
        >
          <option value="" disabled>
            Choose a model…
          </option>
          {provider.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <Button variant="ghost" block disabled={busy} onClick={() => void choose(null)}>
          Let it fail over between all {provider.models.length}
        </Button>
      </div>
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
        <Dictated value={problem} onValueChange={setProblem} disabled={busy} align="start">
          <Textarea
            id="first-problem"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            placeholder="Something that keeps costing me time, and I have never sat down to fix it properly…"
            autoFocus
          />
        </Dictated>
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
