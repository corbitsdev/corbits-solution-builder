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
 *
 * The layout follows `mockups/onboarding.html` (brand pin, whisper track,
 * grouped provider orows, credit). Behaviour stays on the real catalog.
 */
import { ChatInput, useTheme, type ThemeMode } from "@corbits/react-ui";
import { Send } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, ApiFailure, type Provider } from "../client.js";
import { Banner, Mark } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { LOCAL_DEFAULT_BASE_URL, LOCAL_PROVIDER_ID } from "../provider-catalog.js";
import type { ApiKeyProvider, OAuthCandidate } from "./providers.jsx";
import logoAnthropic from "../assets/logos/anthropic.svg";
import logoCorbits from "../assets/logos/corbits.svg";
import logoGoogle from "../assets/logos/google.svg";
import logoOllama from "../assets/logos/ollama.svg";
import logoOpenai from "../assets/logos/openai.svg";
import logoOpencode from "../assets/logos/opencode.svg";
import logoXai from "../assets/logos/xai.svg";
import "./onboarding-layout.css";

type Step = "welcome" | "look" | "provider" | "model" | "project";

const TITLES: Record<Step, [string, string]> = {
  welcome: [
    "Welcome.",
    "Describe a problem. Specialists take it through nine stages — you decide at the gates.",
  ],
  look: [
    "Set it up how you like.",
    "All of this lives in Settings later — nothing here is a commitment.",
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

const THEME_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
];

const MARKS: Record<string, string> = {
  "codex-oauth": logoOpenai,
  openai: logoOpenai,
  "xai-oauth": logoXai,
  xai: logoXai,
  anthropic: logoAnthropic,
  google: logoGoogle,
  "opencode-zen": logoOpencode,
  "opencode-zen-go": logoOpencode,
  opencode: logoOpencode,
  [LOCAL_PROVIDER_ID]: logoOllama,
  ollama: logoOllama,
};

export type OnboardingGroup = "signin" | "apikey" | "local" | "custom";

export type OnboardingRow = {
  id: string;
  name: string;
  kind: "oauth" | "api_key" | "local_endpoint";
  needsBaseUrl: boolean;
  group: OnboardingGroup;
  sub: string;
  action: string;
};

const GROUP_LABEL: Record<OnboardingGroup, string> = {
  signin: "SIGN IN",
  apikey: "API KEY",
  local: "ON THIS MACHINE",
  custom: "CUSTOM",
};

const GROUP_ORDER: readonly OnboardingGroup[] = ["signin", "apikey", "local", "custom"];

/** Logo URL for a catalog provider id, or null when the mockup has no mark. */
export function markForProvider(providerId: string): string | null {
  return MARKS[providerId] ?? null;
}

/**
 * The onboarding list is the live catalog, grouped the way the mockup groups
 * it (sign-in, API key, this machine, a custom endpoint). A row that needs a
 * base URL is custom, not an API-key card with a secret field pretending to
 * be enough.
 */
export function onboardingRows(
  apiKeyProviders: readonly ApiKeyProvider[],
  oauthCandidates: readonly OAuthCandidate[],
): OnboardingRow[] {
  return [
    ...oauthCandidates.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      kind: "oauth" as const,
      needsBaseUrl: false,
      group: "signin" as const,
      sub: "OAuth",
      action: "Sign in",
    })),
    ...apiKeyProviders.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      kind: "api_key" as const,
      needsBaseUrl: entry.needsBaseUrl,
      group: entry.needsBaseUrl ? ("custom" as const) : ("apikey" as const),
      sub: entry.needsBaseUrl ? "OpenAI-compatible" : "API key",
      action: entry.needsBaseUrl ? "Set up" : "Connect",
    })),
    {
      id: LOCAL_PROVIDER_ID,
      name: "Ollama",
      kind: "local_endpoint" as const,
      needsBaseUrl: true,
      group: "local" as const,
      sub: "models load dynamically",
      action: "Detect",
    },
  ];
}

export function groupedOnboardingRows(
  rows: readonly OnboardingRow[],
): { group: OnboardingGroup; label: string; rows: OnboardingRow[] }[] {
  return GROUP_ORDER.flatMap((group) => {
    const list = rows.filter((row) => row.group === group);
    return list.length === 0 ? [] : [{ group, label: GROUP_LABEL[group], rows: list }];
  });
}

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

function draftModelName(providers: readonly Provider[]): string | null {
  const ready = providers.find((provider) => provider.status === "ready");
  if (!ready) return null;
  return ready.selectedModel ?? ready.models[0] ?? null;
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
  const modelLine = draftModelName(providers);

  const goModel = () => {
    const pending = providers.find(needsModelChoice) ?? providers.find((provider) => provider.status === "ready" && provider.models.length > 1);
    if (!pending) return;
    setModelProviderId(pending.id);
    setStep("model");
  };

  return (
    <div className="ob-frame">
      <main className="ob">
        <div className="ob-brand">
          <Mark size={20} />
          <span>Solution Builder</span>
        </div>

        <header className="ob-head swap" key={step}>
          <h1>{title}</h1>
          <p>{sub}</p>
        </header>

        <div className="ob-track" role="img" aria-label={`Step ${index + 1} of ${ORDER.length}`}>
          {ORDER.map((at, i) => (
            <span key={at} className={i < index ? "seg done" : i === index ? "seg now" : "seg"} />
          ))}
        </div>

        <section className="ob-step" key={`step-${step}`}>
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
              onContinue={() => setAwaitingChoice(true)}
              onConnected={async () => {
                await onConnected();
                setAwaitingChoice(true);
              }}
            />
          ) : step === "model" && modelProvider ? (
            <ModelStep provider={modelProvider} onChosen={() => setStep("project")} />
          ) : (
            <ProjectStep
              modelName={modelLine}
              onChangeModel={modelLine && providers.some((provider) => provider.status === "ready" && provider.models.length > 1) ? goModel : null}
              onCreated={onCreated}
              onSkip={onSkipProject}
            />
          )}
        </section>
      </main>

      <p className="ob-credit">
        <img src={logoCorbits} alt="" />
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
        <button type="button" className="btn primary" onClick={onNext}>
          Get started
        </button>
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
          <div className="seg-ctl" role="group" aria-label="Theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={mode === option.id ? "on" : undefined}
                onClick={() => setMode(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="ob-foot">
        <span />
        <button type="button" className="btn primary" onClick={onNext}>
          Continue
        </button>
      </div>
    </>
  );
}

/** Step 3: sign-in, API key, or a local server — the live catalog as orows. */
function ProviderStep({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onSkip,
  onContinue,
  onConnected,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onSkip: () => void;
  onContinue: () => void;
  onConnected: () => Promise<void>;
}) {
  const rows = onboardingRows(apiKeyProviders, oauthCandidates);
  const groups = groupedOnboardingRows(rows);
  const [chosen, setChosen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const cancelledRef = useRef<Set<string>>(new Set());

  const connectedFor = (row: OnboardingRow) => providers.find((provider) => provider.providerId === row.id);

  const act = async (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    setFailed(null);
    cancelledRef.current.delete(id);
    try {
      await work();
      if (cancelledRef.current.has(id)) return;
      await onConnected();
    } catch (cause) {
      if (cancelledRef.current.has(id)) return;
      setFailed(id);
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!cancelledRef.current.has(id)) setBusy(null);
    }
  };

  const connect = (row: OnboardingRow) =>
    act(row.id, async () => {
      if (row.kind === "oauth") {
        await api.connectOAuthProvider({ providerId: row.id, label: row.name }, (url) => {
          if (!cancelledRef.current.has(row.id)) setAuthorizeUrl(url);
        });
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
    void api.cancelProviderSignIn(id).catch(() => undefined);
  };

  const canSave = (row: OnboardingRow) => {
    if (busy !== null) return false;
    if (row.kind === "local_endpoint") return true;
    return secret.trim().length > 0 && (!row.needsBaseUrl || baseUrl.trim().length > 0);
  };

  const openAsk = (row: OnboardingRow) => {
    setChosen(row.id);
    setSecret("");
    setBaseUrl(row.kind === "local_endpoint" || row.needsBaseUrl ? (row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "") : "");
    setError(null);
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

      {groups.map((group) => (
        <Fragment key={group.group}>
          <p className="ob-group">{group.label}</p>
          <div className="ob-list">
            {group.rows.map((row) => {
              const connected = connectedFor(row);
              const ready = connected?.status === "ready";
              const asking = chosen === row.id;
              const waiting = busy === row.id && row.kind === "oauth";
              const working = busy === row.id;
              const sub =
                connected && ready
                  ? `${connected.models.length} model${connected.models.length === 1 ? "" : "s"} on this machine`
                  : waiting
                    ? "Waiting for the browser"
                    : connected
                      ? (connected.statusDetail ?? connected.status)
                      : failed === row.id && row.kind === "local_endpoint"
                        ? "Not detected — start Ollama, then retry"
                        : row.sub;
              const actionLabel = ready
                ? "Connected"
                : waiting
                  ? "Signing in…"
                  : working
                    ? row.kind === "local_endpoint"
                      ? "Detecting…"
                      : "Connecting…"
                    : failed === row.id
                      ? "Retry"
                      : row.action;
              return (
                <div key={row.id}>
                  <div className="orow">
                    <div className="who">
                      <ProviderMark id={row.id} />
                      <span>
                        <b>{row.name}</b>
                        <span>{sub}</span>
                      </span>
                    </div>
                    {waiting ? (
                      <button type="button" className="btn" onClick={() => cancelSignIn(row.id)}>
                        Cancel
                      </button>
                    ) : asking ? (
                      <button type="button" className="btn" onClick={closeAsk}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        disabled={working || busy !== null || ready}
                        onClick={() => {
                          if (row.kind === "oauth") void connect(row);
                          else if (row.kind === "local_endpoint") {
                            setBaseUrl(LOCAL_DEFAULT_BASE_URL);
                            void act(row.id, () => api.connectLocalProvider({ baseUrl: LOCAL_DEFAULT_BASE_URL }));
                          } else openAsk(row);
                        }}
                      >
                        {actionLabel}
                      </button>
                    )}
                  </div>
                  {asking ? (
                    <form
                      className="byo-config"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (canSave(row)) void connect(row);
                      }}
                    >
                      {row.needsBaseUrl ? (
                        <input
                          className="field field-mono"
                          type="text"
                          autoFocus={row.kind === "local_endpoint"}
                          placeholder={row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "http://localhost:8000/v1"}
                          aria-label="Endpoint"
                          autoComplete="off"
                          spellCheck={false}
                          value={baseUrl}
                          onChange={(event) => setBaseUrl(event.target.value)}
                        />
                      ) : null}
                      {row.kind === "api_key" ? (
                        <input
                          className="field field-mono"
                          type="password"
                          autoFocus={!row.needsBaseUrl}
                          value={secret}
                          onChange={(event) => setSecret(event.target.value)}
                          placeholder={`${row.name} API key`}
                          aria-label={`${row.name} API key`}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      ) : null}
                      {row.group === "custom" ? (
                        <p className="byo-note">
                          <b>Heads up</b> — we can't verify a custom endpoint until it answers. If the shape doesn't match, the first run may fail.
                        </p>
                      ) : null}
                      <button type="submit" className="btn" disabled={!canSave(row)} style={{ alignSelf: "flex-end" }}>
                        {working ? "Connecting…" : "Connect"}
                      </button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Fragment>
      ))}

      {error ? <Banner tone="error" title={error} /> : null}

      <div className="ob-foot">
        <button type="button" className="ob-skip" onClick={onSkip}>
          Skip for now
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null || !providers.some((provider) => provider.status === "ready")}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </>
  );
}

function ProviderMark({ id }: { id: string }) {
  const src = markForProvider(id);
  return (
    <span className="provider-mark">
      {src ? (
        <img src={src} alt="" />
      ) : (
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2" y="4" width="20" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M2 8h20" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      )}
    </span>
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
  const [picked, setPicked] = useState<string | null>(provider.models[0] ?? null);

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
            className={picked === model ? "orow pick on" : "orow pick"}
            disabled={busy}
            onClick={() => setPicked(model)}
          >
            <span className="who">
              <span>
                <b className="field-mono">{model}</b>
              </span>
              {index === 0 ? <span className="tag">Recommended</span> : null}
            </span>
            <span className="btn">{picked === model ? "Default" : "Choose"}</span>
          </button>
        ))}
      </div>
      <div className="ob-foot">
        <button type="button" className="ob-skip" disabled={busy} onClick={() => void choose(null)}>
          Let it fail over between all {provider.models.length}
        </button>
        <button type="button" className="btn primary" disabled={busy || picked === null} onClick={() => void choose(picked)}>
          Continue
        </button>
      </div>
    </>
  );
}

/** The last step: the only question worth asking first. The composer sends —
 *  there is no second button for the same action. */
function ProjectStep({
  modelName,
  onChangeModel,
  onCreated,
  onSkip,
}: {
  modelName: string | null;
  onChangeModel: (() => void) | null;
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
        <Dictated value={problem} onValueChange={setProblem} disabled={busy}>
          {(mic) => (
          <ChatInput
            className="composer-box"
            value={problem}
            onValueChange={setProblem}
            onSend={() => void create()}
            working={busy}
            placeholder="What problem are you trying to solve?"
            sendIcon={<Send className="size-4" aria-hidden="true" />}
            leadingTools={mic}
          />
          )}
        </Dictated>
        {modelName ? (
          <p className="ob-model">
            Model · <b>{modelName}</b>
            {onChangeModel ? (
              <>
                {" "}
                ·{" "}
                <button type="button" onClick={onChangeModel}>
                  Change
                </button>
              </>
            ) : null}
          </p>
        ) : null}
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
