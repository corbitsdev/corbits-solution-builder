/**
 * Settings: the mockup's five sections, and nothing else on this page.
 *
 *   1. Appearance — the theme, until the system's own is enough.
 *   2. Inference — live providers: Connect, or Connected plus Refresh models.
 *   3. Designer — surface, design language, output limit.
 *   4. Stakeholder decks — one row per live role; Edit is Theme only.
 *   5. This computer — Connection, Credentials, Data, Version.
 *
 * Host and API keep the rest (catalog order, on-limit, templates, start-at-login,
 * diagnostics) as silent defaults. The secret rule still holds: a key field is
 * cleared the moment it is handed over, and nothing ever renders it back.
 *
 * Layout is the mockup's section / section-body / row / k / v language.
 */
import { useTheme, type ThemeMode } from "@corbits/react-ui";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_DECK_DESIGN, type DeckDesign, type DeckTheme } from "@solutions-builder/app/deck";
import {
  api,
  ApiFailure,
  STAKEHOLDER_ROLES,
  type ActiveModel,
  type DesignerSettings,
  type HostStatus,
  type Provider,
} from "../client.js";
import { Banner } from "../components.jsx";
import { deckDesignFor, deckDesignKey } from "../deck-design-settings.ts";
import { Dictated } from "../dictation.jsx";
import { ProviderList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";
import "./settings-layout.css";

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
    <div className="settings-page">
      <h1>Settings</h1>
      <Appearance />
      <Inference
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onChanged}
      />
      <Designer />
      <StakeholderDecks />
      <ThisComputer status={status} />
    </div>
  );
}

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head">
        <h2>{title}</h2>
        {lead ? <p>{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <div className="k">
        <b>{label}</b>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function SegCtl<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { id: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="seg-ctl" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={option.id === value ? "on" : undefined}
          disabled={disabled}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- appearance */

/** The theme, as a segmented choice — the same control onboarding's Look step
    uses. Persists through ThemeProvider; nothing else is asked yet. */
function Appearance() {
  const { mode, setMode } = useTheme();
  return (
    <Section title="Appearance" lead="Follows the system until you say otherwise.">
      <div className="section-body">
        <Row label="Theme">
          <SegCtl<ThemeMode>
            label="Theme"
            value={mode}
            onChange={setMode}
            options={[
              { id: "light", label: "Light" },
              { id: "system", label: "System" },
              { id: "dark", label: "Dark" },
            ]}
          />
        </Row>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- inference */

function Inference({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onChanged,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  onChanged: () => void;
}) {
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .activeModel()
      .then((model) => {
        if (!cancelled) setActiveModel(model);
      })
      .catch(() => {
        // Supplementary row; the provider list below still loads and reports its own errors.
      });
    return () => {
      cancelled = true;
    };
    // Re-reads after `onChanged` refetches `providers` (a new array on every
    // change), so picking a default shows up here immediately, not just on
    // the next reload.
  }, [providers]);

  return (
    <Section title="Inference" lead="Where the specialists think. Keys live in this machine's keychain.">
      <div id="connections" className="section-body">
        {activeModel ? (
          <Row label="Default model" hint="The top row below: the provider and model tried first. Each row under it is tried, in order, if the one above fails. Drag rows to change the order.">
            <span className="v">
              {activeModel.providerLabel} · {activeModel.canonicalName}
            </span>
          </Row>
        ) : null}
        <ProviderList
          manage
          providers={providers}
          apiKeyProviders={apiKeyProviders}
          oauthCandidates={oauthCandidates}
          onChanged={onChanged}
        />
      </div>
    </Section>
  );
}

/* ----------------------------------------------------------------- designer */

/**
 * What the stage-4 designer draws to. Each control saves on its own as it
 * changes; the design language saves when the field is left, since it is
 * typed. The output limit stays a host default — not a row here.
 */
function Designer() {
  const [settings, setSettings] = useState<DesignerSettings | null>(null);
  const [language, setLanguage] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .designerSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setLanguage(loaded.language);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async <K extends keyof DesignerSettings>(key: K, value: DesignerSettings[K]) => {
    if (!settings) return;
    setError(null);
    const before = settings;
    setSettings({ ...settings, [key]: value });
    try {
      await api.saveDesignerSetting(key, value);
    } catch (cause) {
      setSettings(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section title="Designer" lead="What the stage-4 designer draws to, and how much it may write.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        <Row label="Surface" hint="Light, dark, or what the brief calls for">
          <SegCtl<DesignerSettings["surface"]>
            label="Surface"
            value={settings?.surface ?? "light"}
            disabled={!settings}
            onChange={(value) => void save("surface", value)}
            options={[
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
              { id: "brief", label: "Brief" },
            ]}
          />
        </Row>
        <Row label="Design language" hint="Palette, type, tone — in your words">
          <Dictated value={language} onValueChange={setLanguage} disabled={!settings} align="center">
            <input
              className="field"
              aria-label="Design language"
              value={language}
              disabled={!settings}
              placeholder="e.g. one accent colour, generous whitespace, no gradients"
              onChange={(event) => setLanguage(event.target.value)}
              onBlur={() => {
                if (settings && language !== settings.language) void save("language", language);
              }}
            />
          </Dictated>
        </Row>
      </div>
    </Section>
  );
}

export function roleLabel(role: string): string {
  const words = role.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The mockup names three looks. Live decks still save colour ids; these three
 * are the closest, and forest/plum fold onto Detailed/Bold for display.
 */
export const DECK_THEME_CHOICES = [
  { id: "slate", label: "Minimal" },
  { id: "navy", label: "Detailed" },
  { id: "ember", label: "Bold" },
] as const satisfies readonly { id: DeckTheme; label: string }[];

type DeckThemeChoice = (typeof DECK_THEME_CHOICES)[number]["id"];

const DECK_THEME_FALLBACK: Record<DeckTheme, DeckThemeChoice> = {
  slate: "slate",
  navy: "navy",
  ember: "ember",
  forest: "navy",
  plum: "ember",
};

export function deckThemeChoice(theme: DeckTheme): DeckThemeChoice {
  return DECK_THEME_FALLBACK[theme];
}

export function deckThemeLabel(theme: DeckTheme): string {
  const id = deckThemeChoice(theme);
  return DECK_THEME_CHOICES.find((choice) => choice.id === id)?.label ?? "Minimal";
}

/**
 * How each stakeholder role's deck is composed. Edit opens Theme only; typeface,
 * density, notes, images and guidance stay as saved host defaults.
 */
function StakeholderDecks() {
  const [designs, setDesigns] = useState<Record<string, DeckDesign> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .deckDesigns()
      .then((preferences) => {
        if (cancelled) return;
        setDesigns(Object.fromEntries(STAKEHOLDER_ROLES.map((role) => [role, deckDesignFor(role, preferences)])));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveTheme = async (role: string, value: DeckTheme) => {
    if (!designs) return;
    setError(null);
    const before = designs;
    setDesigns({ ...designs, [role]: { ...designs[role]!, theme: value } });
    try {
      await api.saveDeckDesignPreference(deckDesignKey(role, "theme"), value);
    } catch (cause) {
      setDesigns(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section title="Stakeholder decks" lead="How the deck each role receives is composed.">
      <div className="section-body">
        <p className="inline-note">The theme you pick here only changes the slides you download at stage 5.</p>
        {error ? <Banner tone="error" title={error} /> : null}
        {STAKEHOLDER_ROLES.map((role) => {
          const design = designs?.[role] ?? DEFAULT_DECK_DESIGN;
          const themeLabel = deckThemeLabel(design.theme);
          const open = editing === role;
          return (
            <Fragment key={role}>
              <Row label={roleLabel(role)} hint={`${themeLabel} theme`}>
                <button
                  type="button"
                  className="btn link"
                  disabled={!designs}
                  onClick={() => setEditing(open ? null : role)}
                >
                  Edit
                </button>
              </Row>
              {open ? (
                <Row label="Theme">
                  <SegCtl<DeckThemeChoice>
                    label={`Theme for ${roleLabel(role)}`}
                    value={deckThemeChoice(design.theme)}
                    disabled={!designs}
                    onChange={(value) => void saveTheme(role, value)}
                    options={DECK_THEME_CHOICES}
                  />
                </Row>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ this computer */

/** Local runs the hub in this process on the embedded database; remote points
    at a separately hosted Interchange (`status.hub.mode`, from hub-client.ts). */
export function hostConnectionCopy(status: HostStatus): string {
  return status.hub.mode === "embedded" ? "Local Interchange Connection" : "Remote Interchange Connection";
}

/**
 * A remote hub mints its own account and holds provider credentials in its
 * own storage, never this host's local keychain/file (see
 * `packages/embedded-host/src/hub-client.ts`). Embedded, it's this host's own
 * backend: the OS keychain where available, else a private file.
 */
export function hostCredentialsCopy(status: HostStatus): string {
  if (status.hub.mode === "remote") return "Interchange Credential Storage";
  return status.credentialBackend === "keychain" ? "macOS Keychain" : "private file on disk";
}

export function hostDataCopy(status: HostStatus): string | null {
  return status.dataDir ?? null;
}

function ThisComputer({ status }: { status: HostStatus | null }) {
  return (
    <Section title="This computer" lead="The host does the work. This window is only how you watch it.">
      <div className="section-body">
        {status ? (
          <Row label="Connection">
            <span className="v">{hostConnectionCopy(status)}</span>
          </Row>
        ) : null}
        {status ? (
          <Row label="Credentials">
            <span className="v">{hostCredentialsCopy(status)}</span>
          </Row>
        ) : null}
        {status && hostDataCopy(status) ? (
          <Row label="Data">
            <span className="v">{hostDataCopy(status)}</span>
          </Row>
        ) : null}
        {status ? (
          <Row label="Version">
            <span className="v">internal-beta</span>
          </Row>
        ) : null}
      </div>
    </Section>
  );
}
