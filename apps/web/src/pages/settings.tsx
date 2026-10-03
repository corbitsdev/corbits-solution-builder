/**
 * Settings: the mockup's five sections, and nothing else on this page.
 *
 *   1. Appearance — the theme, until the system's own is enough.
 *   2. Inference — live providers: Connect, or Connected plus Refresh models.
 *   3. Designer — surface, design language, output limit.
 *   4. Stakeholder decks — one row per live role; Edit is Theme only.
 *   5. Design documents — the guidelines and presentations every deck is
 *      built against (#246); a project can add its own or turn these off.
 *   6. This computer — Connection, Credentials, Data, Version.
 *
 * Host and API keep the rest (catalog order, on-limit, templates, start-at-login,
 * diagnostics) as silent defaults. The secret rule still holds: a key field is
 * cleared the moment it is handed over, and nothing ever renders it back.
 *
 * Layout is the mockup's section / section-body / row / k / v language.
 */
import { useTheme, type ThemeMode } from "@corbits/react-ui";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_DECK_DESIGN, roleLabel, type DeckDesign, type DeckTheme } from "@solutions-builder/app/deck";
import { LANGUAGES, SUPPORTED_OUTPUT_LANGUAGES, type LanguageId, type LanguageSettings } from "@solutions-builder/app/language-settings";
import {
  api,
  ApiFailure,
  STAKEHOLDER_ROLES,
  type ActiveModel,
  type BuildWorkerStatus,
  type DesignerSettings,
  type GoogleDriveStatus,
  type HostStatus,
  type Provider,
} from "../client.js";
import { Banner, StateLabel } from "../components.jsx";
import { deckDesignFor, deckDesignKey } from "../deck-design-settings.ts";
import { Dictated } from "../dictation.jsx";
import { DesignDocumentsList } from "./design-documents.jsx";
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
      <Language />
      <Inference
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onChanged}
      />
      <Designer />
      <BuildWorker />
      <StakeholderDecks />
      <DesignDocuments />
      <GoogleDrive />
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

/* ------------------------------------------------------------ build worker */

/** What the install row says, from the host's own instruction. Pure, for the test. */
export function workerInstallCopy(status: Pick<BuildWorkerStatus, "available" | "detail" | "install">): string {
  if (status.available) return status.detail;
  return status.install ? status.install.text : status.detail;
}

/**
 * Which coding agent stage 8 hands the frozen packet to. The host's bridge
 * runs one tool's non-interactive form and reports final text and an exit
 * status whichever it is; the choice here changes the tool, not what the
 * bridge can see. Whether the tool is on this computer is the host's word,
 * asked for on every change and on "Check again", and when it is absent the
 * host says how to get it for this operating system.
 */
function BuildWorker() {
  const [status, setStatus] = useState<BuildWorkerStatus | null>(null);
  const [executable, setExecutable] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const loaded = await api.buildWorker();
      setStatus(loaded);
      setExecutable(loaded.settings.executable);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
    // Once, on open: later checks are the person's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: { worker?: string; executable?: string }) => {
    setError(null);
    try {
      const saved = await api.setBuildWorker(patch);
      setStatus(saved);
      setExecutable(saved.settings.executable);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  const chosen = status?.workers.find((entry) => entry.id === status.settings.worker);
  return (
    <Section title="Build worker" lead="The coding agent stage 8 hands the frozen plan to. It runs on this computer, with your own configuration of that tool, and the build shows its final output and exit status and nothing more.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        <Row label="Tool" hint="Corbits Code is the default">
          <SegCtl<string>
            label="Build worker"
            value={status?.settings.worker ?? "corbits-code"}
            disabled={!status}
            onChange={(value) => void save({ worker: value })}
            options={(status?.workers ?? [{ id: "corbits-code", label: "Corbits Code", executable: "corbits" }]).map((entry) => ({ id: entry.id, label: entry.label }))}
          />
        </Row>
        <Row label="Executable" hint={`Empty means \`${chosen?.executable ?? "the tool's own name"}\` from this computer's PATH; a full path for an install elsewhere`}>
          <input
            className="field"
            aria-label="Build worker executable"
            value={executable}
            disabled={!status}
            placeholder={chosen?.executable ?? ""}
            spellCheck={false}
            onChange={(event) => setExecutable(event.target.value)}
            onBlur={() => {
              if (status && executable.trim() !== status.settings.executable) void save({ executable: executable.trim() });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
        </Row>
        <Row label="On this computer" {...(status ? { hint: `Checked ${new Date(status.checkedAt).toLocaleTimeString()}` } : {})}>
          <span className="v">
            {status ? (
              <>
                <StateLabel tone={status.available ? "success" : "error"}>{status.available ? "Available" : "Not found"}</StateLabel>{" "}
                {workerInstallCopy(status)}
                {!status.available && status.install?.command ? (
                  <>
                    {" "}
                    <code>{status.install.command}</code>
                  </>
                ) : null}
                {!status.available && status.install?.url ? (
                  <>
                    {" "}
                    <a href={status.install.url} target="_blank" rel="noreferrer">
                      {status.install.url}
                    </a>
                  </>
                ) : null}
              </>
            ) : (
              "Checking…"
            )}{" "}
            <button type="button" className="btn link" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </span>
        </Row>
      </div>
    </Section>
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

/* ----------------------------------------------------------------- language */

/** What the Output language select says of a language that cannot be chosen yet. */
export function languageOptionLabel(id: LanguageId, label: string, forOutput: boolean): string {
  return forOutput && !SUPPORTED_OUTPUT_LANGUAGES.includes(id) ? `${label} (not supported yet)` : label;
}

/**
 * The workspace's languages (#411): what you write in, and what every
 * specialist writes in, documents and the software it builds alike. Only
 * the two Englishes are offered as output for now; the rest are listed so
 * the choice is visible, and disabled.
 */
function Language() {
  const [settings, setSettings] = useState<LanguageSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .languageSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const save = async <K extends keyof LanguageSettings>(key: K, value: LanguageSettings[K]) => {
    if (!settings) return;
    setError(null);
    const before = settings;
    setSettings({ ...settings, [key]: value });
    try {
      setSettings(await api.saveLanguageSetting(key, value));
    } catch (cause) {
      setSettings(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    }
  };
  const select = (key: keyof LanguageSettings, label: string) => (
    <select
      className="field"
      aria-label={label}
      value={settings?.[key] ?? "en-US"}
      disabled={!settings}
      onChange={(event) => void save(key, event.target.value as LanguageId)}
    >
      {LANGUAGES.map((language) => (
        <option key={language.id} value={language.id} disabled={key === "output" && !SUPPORTED_OUTPUT_LANGUAGES.includes(language.id)}>
          {languageOptionLabel(language.id, language.label, key === "output")}
        </option>
      ))}
    </select>
  );
  return (
    <Section title="Language" lead="What you write in, and what the specialists write in. American English unless you say otherwise.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        <Row label="Input language" hint="The language of your messages and material">{select("input", "Input language")}</Row>
        <Row label="Output language" hint="Every document, reply, and the text of any software built. American English and British English for now.">
          {select("output", "Output language")}
        </Row>
      </div>
    </Section>
  );
}

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

export { roleLabel };

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

/* ------------------------------------------------------------ design documents */

/**
 * The workspace's deck design documents (#246): guidelines and existing
 * presentations every project's decks are drafted and drawn against, unless
 * a project turns them off in its own settings. The list itself is shared
 * with the project settings dialog.
 */
function DesignDocuments() {
  return (
    <Section
      title="Design documents"
      lead="What every stakeholder deck is built against. A project can add its own from its card's menu, or turn these off there."
    >
      <div className="section-body">
        <DesignDocumentsList emptyNote="None yet. Decks use the built-in look and follow the presentation creator's own judgement." />
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

/* ------------------------------------------------------------- google drive */

/** What the connection row says: who is connected, or what connecting takes. */
export function googleDriveCopy(status: GoogleDriveStatus | null): string {
  if (!status) return "Checking…";
  if (status.connected) return status.email ? `Connected as ${status.email}.` : "Connected.";
  if (status.login.status === "pending") return "Finish signing in to Google in your browser.";
  return status.clientId ? "Not connected. The OAuth client is remembered; connect to sign in again." : "Not connected.";
}

export const GOOGLE_CLIENT_HOWTO =
  "In Google Cloud Console, enable the Google Drive API, then under APIs & Services → Credentials create an OAuth client of type Desktop app and paste its client ID and secret here. Only files this app creates are touched.";

/**
 * One click from a stakeholder's slides to Google Slides (#233). Google
 * writes to a person's Drive only for an OAuth client of their own, so the
 * client's id and secret are pasted here once and kept in the keychain; the
 * sign-in is the host's loopback flow, the same as ChatGPT's.
 */
function GoogleDrive() {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const refresh = () =>
    api.googleDrive
      .status()
      .then(setStatus)
      .catch((cause: unknown) => setError(cause instanceof ApiFailure ? cause.detail.message : String(cause)));
  useEffect(() => {
    void refresh();
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    cancelled.current = false;
    try {
      const { authorizeUrl: url } = await api.googleDrive.connect({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      if (!cancelled.current) setAuthorizeUrl(url);
      const next = await api.googleDrive.awaitLogin();
      setStatus(next);
      setClientId("");
      setClientSecret("");
    } catch (cause) {
      if (!cancelled.current) setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAuthorizeUrl(null);
      setBusy(false);
    }
  };
  const cancel = () => {
    cancelled.current = true;
    setAuthorizeUrl(null);
    setBusy(false);
    void api.googleDrive.cancel().then(() => refresh());
  };
  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.googleDrive.disconnect());
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const canConnect = !busy && (Boolean(status?.clientId) || (clientId.trim().length > 0 && clientSecret.trim().length > 0));

  return (
    <Section title="Google Drive" lead="Where “Open in Google Slides” puts a stakeholder's deck.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        {authorizeUrl ? (
          <Banner title="Finish signing in, in your browser" action={{ label: "Cancel", onClick: cancel }}>
            <span className="hash">{authorizeUrl}</span>
          </Banner>
        ) : null}
        <Row label="Connection">
          <span className="v">{googleDriveCopy(status)}</span>
          {status?.connected ? (
            <button type="button" className="btn link" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          ) : null}
        </Row>
        {status && !status.connected ? (
          <>
            <Row label="OAuth client" hint={GOOGLE_CLIENT_HOWTO}>
              <input
                className="field"
                aria-label="Google OAuth client ID"
                value={clientId}
                disabled={busy}
                placeholder={status.clientId ?? "…apps.googleusercontent.com"}
                autoComplete="off"
                onChange={(event) => setClientId(event.target.value)}
              />
            </Row>
            <Row label="Client secret" {...(status.clientId ? { hint: "Leave blank to keep the one remembered." } : {})}>
              <input
                className="field"
                type="password"
                aria-label="Google OAuth client secret"
                value={clientSecret}
                disabled={busy}
                placeholder={status.clientId ? "(remembered)" : "GOCSPX-…"}
                autoComplete="off"
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </Row>
            <Row label="">
              <button type="button" className="btn" disabled={!canConnect} onClick={() => void connect()}>
                {busy ? "Connecting…" : "Connect Google Drive"}
              </button>
            </Row>
          </>
        ) : null}
      </div>
    </Section>
  );
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
