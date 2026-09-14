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
import { useState } from "react";
import { api, ApiFailure, type Provider } from "../client.js";
import { Banner, Button, Mark } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { ProviderList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";

type Step = "provider" | "project";

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
