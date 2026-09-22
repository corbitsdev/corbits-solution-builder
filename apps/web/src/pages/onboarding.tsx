/**
 * Onboarding — the guided path into the product.
 *
 * A stepped shell, one question per step: welcome, the look, connect
 * inference, pick a model when the connection genuinely offers a choice,
 * then describe the first problem. Nothing else is offered until those are
 * done, so there is nothing to get lost in.
 *
 * What is deliberately not a step: the owner account and workspace mint
 * automatically on an embedded hub (`app.tsx`'s `mintOwner`) — there is no
 * form for them because nothing about them is asked. Preferences beyond the
 * theme have no persistence yet, so they are not shown — a switch that does
 * nothing is worse than its absence.
 *
 * Policy (cost tolerance, audiences, quorum) is not asked here. Somebody
 * arriving with a half-formed problem does not yet know what their cost
 * tolerance is, and asking is how a first run stalls. Sensible defaults apply
 * and Settings can change them before any review begins.
 */
import { ChatInput, SegmentedControl, useTheme, type ThemeMode } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, ApiFailure, type Provider } from "../client.js";
import { Banner, Button, Mark } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { ProviderList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";

type Step = "welcome" | "look" | "provider" | "model" | "project";

const TITLES: Record<Step, [string, string]> = {
  welcome: [
    "Welcome.",
    "Describe a problem. Specialists take it through nine stages — you decide at the gates.",
  ],
  look: [
    "Set it up how you like.",
    "This lives in Settings later — nothing here is a commitment.",
  ],
  provider: [
    "Connect a provider.",
    "API key, sign-in, or something running on this machine — keys and tokens stay here either way.",
  ],
  model: [
    "Which model should it draft with?",
    "Per stage later — this is just the default.",
  ],
  project: [
    "What problem are you trying to solve?",
    "A sentence is enough. The discovery specialist will pull it apart with you.",
  ],
};

/**
 * Whether the model step is needed for a provider: ready, serving a real
 * choice of models, with nothing selected yet. Nothing is pinned at
 * connect/refresh time — the default is the priority-first enabled model
 * (CL-8781), derived at read time — so a fresh connection never lands here;
 * the step stays only as a fallback (every model restricted, or a choice
 * predating priority defaults).
 */
export function needsModelChoice(provider: { status: string; selectedModel: string | null; models: readonly string[] }): boolean {
  return provider.status === "ready" && provider.models.length > 1 && provider.selectedModel === null;
}

export function Onboarding({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onConnected,
  onCreated,
  onSkipProject,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onConnected: () => Promise<void>;
  onCreated: (projectId: string) => void;
  /** "I'll do this later" on the last step — leaves setup without a project. */
  onSkipProject: () => void;
}) {
  const connected = providers.some((provider) => provider.status === "ready");
  const [step, setStep] = useState<Step>(connected ? "project" : "welcome");
  // Set right after a connect, before the refreshed `providers` prop lands --
  // the effect below picks the next step once it does, rather than this
  // component guessing from the stale list it already has.
  const [awaitingChoice, setAwaitingChoice] = useState(false);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (!awaitingChoice) return;
    setAwaitingChoice(false);
    const pending = providers.find(needsModelChoice);
    if (pending) {
      setModelProviderId(pending.id);
      setStep("model");
    } else {
      setStep("project");
    }
  }, [providers, awaitingChoice]);

  const modelProvider = providers.find((provider) => provider.id === modelProviderId) ?? null;
  // The track's count is fixed; a skipped model step reads as done the
  // moment the flow passes it rather than resizing the track mid-flow.
  const ORDER: readonly Step[] = ["welcome", "look", "provider", "model", "project"];
  const index = step === "model" && modelProvider === null ? ORDER.indexOf("project") : ORDER.indexOf(step);
  const [title, sub] = TITLES[step];

  return (
    <div className="onboarding">
      <div className="onboarding-brand">
        <Mark size={20} />
        <strong>Solutions Builder</strong>
      </div>

      <main className="onboarding-card">
        <header className="onboarding-head" key={step}>
          <h1>{title}</h1>
          <p className="lede">{sub}</p>
        </header>

        <div className="ob-track" role="img" aria-label={`Step ${index + 1} of ${ORDER.length}`}>
          {ORDER.map((at, i) => (
            <span key={at} className={i < index ? "seg done" : i === index ? "seg now" : "seg"} />
          ))}
        </div>

        {step === "welcome" ? (
          <WelcomeStep onSkip={() => setStep("provider")} onNext={() => setStep("look")} />
        ) : step === "look" ? (
          <LookStep onNext={() => setStep("provider")} />
        ) : step === "provider" ? (
          <ProviderStep
            providers={providers}
            apiKeyProviders={apiKeyProviders}
            oauthCandidates={oauthCandidates}
            onSkip={() => setStep("project")}
            onConnected={async () => {
              await onConnected();
              setAwaitingChoice(true);
            }}
          />
        ) : step === "model" && modelProvider ? (
          <ModelStep provider={modelProvider} onChosen={() => setStep("project")} />
        ) : (
          <ProjectStep onCreated={onCreated} onSkip={onSkipProject} />
        )}
      </main>

      <p className="onboarding-foot">
        <Mark size={14} />
        <span>Powered by Corbits</span>
      </p>
    </div>
  );
}

/** Step 1: what this is, in three lines, then the way in. */
function WelcomeStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  return (
    <>
      <ul className="ob-points">
        <li>
          <span>
            <b>Stages, not chat.</b> Discovery to delivery — each stage produces an artifact, not a transcript.
          </span>
        </li>
        <li>
          <span>
            <b>You hold the gates.</b> Nothing advances until you approve it. Replying sends it back.
          </span>
        </li>
        <li>
          <span>
            <b>Runs on this machine.</b> Keys in your keychain, work in your workspace. No cloud account needed.
          </span>
        </li>
      </ul>
      <div className="ob-foot">
        <button type="button" className="ob-skip" onClick={onSkip}>
          Skip setup
        </button>
        <Button variant="primary" onClick={onNext}>
          Get started
        </Button>
      </div>
    </>
  );
}

/** Step 2: the only persisted preference a first screen can honestly offer —
    the theme. The rest of Settings waits until there is something to set. */
function LookStep({ onNext }: { onNext: () => void }) {
  const { mode, setMode } = useTheme();
  return (
    <>
      <div className="ob-list">
        <div className="orow">
          <div className="who">
            <span>
              <b>Theme</b>
              <span className="sub">Follows the system until you say otherwise</span>
            </span>
          </div>
          <SegmentedControl<ThemeMode>
            label="Theme"
            value={mode}
            onValueChange={setMode}
            options={[
              { id: "light", label: "Light" },
              { id: "system", label: "System" },
              { id: "dark", label: "Dark" },
            ]}
          />
        </div>
      </div>
      <div className="ob-foot">
        <span />
        <Button variant="primary" onClick={onNext}>
          Continue
        </Button>
      </div>
    </>
  );
}

/** Step 3: the shared provider list — sign-in, API key, or a local server. */
function ProviderStep({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onSkip,
  onConnected,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onSkip: () => void;
  onConnected: () => Promise<void>;
}) {
  return (
    <>
      <ProviderList
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onConnected}
      />
      <div className="ob-foot">
        <button type="button" className="ob-skip" onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </>
  );
}

/**
 * Shown only when the provider just connected serves more than one model --
 * otherwise the specialists would silently draft with whichever the endpoint
 * happened to list first. The first listed is the priority default, so it
 * carries the "Recommended" tag; `api.selectProviderModel` records the
 * choice and the Settings catalog manages the default from then on.
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
      {error ? <Banner tone="error" title={error} /> : null}

      <div className="ob-list">
        {provider.models.map((model, index) => (
          <button
            key={model}
            type="button"
            className={index === 0 ? "orow pick on" : "orow pick"}
            disabled={busy}
            onClick={() => void choose(model)}
          >
            <span className="who">
              <span className="model-name">{model}</span>
              {index === 0 ? <span className="tag">Recommended</span> : null}
            </span>
            <span className="orow-pick">{index === 0 ? "Default" : "Choose"}</span>
          </button>
        ))}
      </div>
      <div className="ob-foot">
        <button type="button" className="ob-skip" disabled={busy} onClick={() => void choose(null)}>
          Let it fail over between all {provider.models.length}
        </button>
      </div>
    </>
  );
}

/** The last step: the only question worth asking first. The composer sends —
 *  there is no second button for the same action. */
function ProjectStep({
  onCreated,
  onSkip,
}: {
  onCreated: (projectId: string) => void;
  onSkip: () => void;
}) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (problem.trim().length < 10) return;
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
      {error ? <Banner tone="error" title={error} /> : null}

      <div className="ask">
        <Dictated value={problem} onValueChange={setProblem} disabled={busy} align="start">
          <ChatInput
            value={problem}
            onValueChange={setProblem}
            onSend={() => void create()}
            working={busy}
            placeholder="Something that keeps costing me time, and I have never sat down to fix it properly…"
          />
        </Dictated>
        <p className="start-hint">
          {problem.trim().length > 0 && problem.trim().length < 10
            ? "A little more. A sentence is enough."
            : "Enter to begin. Rough is fine."}
        </p>
      </div>
      <div className="ob-foot">
        <button type="button" className="ob-skip" onClick={onSkip}>
          Skip — I'll do this later
        </button>
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
