/**
 * Settings: five things a person can actually change.
 *
 *   1. Appearance — the theme, until the system's own is enough.
 *   2. Inference — which providers answer, in what order, with which model.
 *   3. Designer — the surface and design language it draws to, how much it
 *      may write, and what happens when a design is cut short.
 *   4. This computer — whether the host starts at login, and stopping it.
 *   5. Diagnostics — folded away; for when something is wrong.
 *
 * The secret rule shows up in the markup: a key field is cleared the moment it
 * is handed over, and nothing ever renders it back. What the UI sees is a
 * status and a boolean.
 *
 * Layout is the mockup's section / section-body / row / k / v language.
 */
import { Switch, useTheme, type ThemeMode } from "@corbits/react-ui";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { DECK_DENSITY, DECK_THEMES, DECK_TYPEFACES, DEFAULT_DECK_DESIGN, type DeckDensity, type DeckDesign, type DeckTheme, type DeckTypeface } from "@solutions-builder/app/deck";
import { invoke } from "@tauri-apps/api/core";
import { api, ApiFailure, STAKEHOLDER_ROLES, type DesignerSettings, type HostStatus, type Provider } from "../client.js";
import { Banner, Button } from "../components.jsx";
import { deckDesignFor, deckDesignKey, guidanceFor } from "../deck-design-settings.ts";
import { Dictated } from "../dictation.jsx";
import { createHubTransport } from "../hub.ts";
import { inShell } from "../shell.ts";
import { ProviderList, ResolvedCatalogList, type ApiKeyProvider, type OAuthCandidate } from "./providers.jsx";
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
      <DeckTemplates />
      <ThisComputer status={status} />
      <Diagnostics status={status} />
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
  return (
    <Section title="Inference" lead="Where the specialists think. Keys live in this machine's keychain.">
      <div id="connections" className="section-body">
        <ProviderList
          manage
          providers={providers}
          apiKeyProviders={apiKeyProviders}
          oauthCandidates={oauthCandidates}
          onChanged={onChanged}
        />
      </div>
      <div className="section-body">
        <ResolvedCatalogList providers={providers} onChanged={onChanged} />
      </div>
    </Section>
  );
}

/* ----------------------------------------------------------------- designer */

const TOKENS_MIN = 1000;
const TOKENS_MAX = 64000;
/** What the host uses when nothing is saved; kept in step with the host's own default. */
const TOKENS_DEFAULT = 32000;

/**
 * What the stage-4 designer draws to and how much it may write. Each control
 * saves on its own as it changes, the way the start-at-login switch does; the
 * design language saves when the field is left, since it is typed.
 */
function Designer() {
  const [settings, setSettings] = useState<DesignerSettings | null>(null);
  const [language, setLanguage] = useState("");
  const [tokens, setTokens] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .designerSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setLanguage(loaded.language);
        setTokens(String(loaded.maxTokens));
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

  const saveTokens = () => {
    const value = Number(tokens);
    if (!Number.isInteger(value) || value < TOKENS_MIN || value > TOKENS_MAX) {
      setTokens(String(settings?.maxTokens ?? TOKENS_DEFAULT));
      setError(`The output limit is a whole number between ${TOKENS_MIN} and ${TOKENS_MAX} tokens.`);
      return;
    }
    if (value !== settings?.maxTokens) void save("maxTokens", value);
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
        <Row
          label="Output limit"
          hint="Tokens per design — most need 20,000–40,000; a design that uses them all is cut short"
        >
          <input
            className="field narrow"
            aria-label="Output limit in tokens"
            type="number"
            inputMode="numeric"
            min={TOKENS_MIN}
            max={TOKENS_MAX}
            step={500}
            value={tokens}
            disabled={!settings}
            onChange={(event) => setTokens(event.target.value)}
            onBlur={saveTokens}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
          />
        </Row>
        <Row
          label="If a design exceeds the limit"
          hint="Tell you and stop; raise the limit and try once more; or try once more at lower resolution within the limit, and tell you."
        >
          <select
            className="field"
            aria-label="If a design exceeds the limit"
            value={settings?.onLimit ?? "tell"}
            disabled={!settings}
            onChange={(event) => void save("onLimit", event.target.value as DesignerSettings["onLimit"])}
          >
            <option value="tell">Tell me and do nothing else</option>
            <option value="raise">Raise the limit and try again</option>
            <option value="reduce">Produce a lower-resolution design and tell me</option>
          </select>
        </Row>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------- deck templates */

type DeckTemplate = { id: string; name: string; mediaType: string; createdAt: string };

export function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * How each stakeholder role's deck is designed: its look, and what its
 * outline should emphasise. A budget approver and a technical approver do
 * not want the same slides. Selects save as they change; the guidance
 * saves when the field is left, since it is typed.
 */
function StakeholderDecks() {
  const [designs, setDesigns] = useState<Record<string, DeckDesign> | null>(null);
  const [guidance, setGuidance] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .deckDesigns()
      .then((preferences) => {
        if (cancelled) return;
        setDesigns(Object.fromEntries(STAKEHOLDER_ROLES.map((role) => [role, deckDesignFor(role, preferences)])));
        setGuidance(Object.fromEntries(STAKEHOLDER_ROLES.map((role) => [role, guidanceFor(role, preferences)])));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async <K extends "theme" | "typeface" | "density" | "notes" | "images" | "guidance">(
    role: string,
    key: K,
    value: DeckDesign[K],
  ) => {
    if (!designs) return;
    setError(null);
    const before = designs;
    setDesigns({ ...designs, [role]: { ...designs[role]!, [key]: value } });
    try {
      await api.saveDeckDesignPreference(deckDesignKey(role, key), value);
    } catch (cause) {
      setDesigns(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section title="Stakeholder decks" lead="How the deck each role receives is composed.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        {STAKEHOLDER_ROLES.map((role) => {
          const design = designs?.[role] ?? DEFAULT_DECK_DESIGN;
          const themeLabel = DECK_THEMES[design.theme].label;
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
                <>
                  <Row label="Colour">
                    <select
                      className="field"
                      aria-label={`Colour for ${roleLabel(role)}`}
                      value={design.theme}
                      disabled={!designs}
                      onChange={(event) => void save(role, "theme", event.target.value as DeckTheme)}
                    >
                      {Object.entries(DECK_THEMES).map(([value, meta]) => (
                        <option key={value} value={value}>
                          {meta.label}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Typeface">
                    <select
                      className="field"
                      aria-label={`Typeface for ${roleLabel(role)}`}
                      value={design.typeface}
                      disabled={!designs}
                      onChange={(event) => void save(role, "typeface", event.target.value as DeckTypeface)}
                    >
                      {DECK_TYPEFACES.map((face) => (
                        <option key={face} value={face}>
                          {face}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Density">
                    <select
                      className="field"
                      aria-label={`Density for ${roleLabel(role)}`}
                      value={design.density}
                      disabled={!designs}
                      onChange={(event) => void save(role, "density", event.target.value as DeckDensity)}
                    >
                      <option value="sparse">Sparse · up to {DECK_DENSITY.sparse} points a slide</option>
                      <option value="standard">Standard · up to {DECK_DENSITY.standard}</option>
                      <option value="full">Full · up to {DECK_DENSITY.full}</option>
                    </select>
                  </Row>
                  <Row label="Speaker notes">
                    <Switch checked={design.notes} disabled={!designs} onCheckedChange={(checked) => void save(role, "notes", checked)} />
                  </Row>
                  <Row label="Images">
                    <select
                      className="field"
                      aria-label={`Images for ${roleLabel(role)}`}
                      value={design.images}
                      disabled={!designs}
                      onChange={(event) => void save(role, "images", event.target.value as DeckDesign["images"])}
                    >
                      <option value="none">None</option>
                      <option value="cover">The cover</option>
                      <option value="some">Some slides, chosen for the content</option>
                      <option value="all">The cover and every slide</option>
                    </select>
                  </Row>
                  <Row label="What the outline should emphasise" hint="In your words, for this role: what to lead with, what to leave out, the tone.">
                    <Dictated
                      value={guidance[role] ?? ""}
                      onValueChange={(next) => setGuidance({ ...guidance, [role]: next })}
                      disabled={!designs}
                      align="start"
                    >
                      <textarea
                        className="field"
                        aria-label={`Deck guidance for ${roleLabel(role)}`}
                        value={guidance[role] ?? ""}
                        disabled={!designs}
                        placeholder="e.g. Lead with cost and timeline; one risk slide at most; no implementation detail."
                        onChange={(event) => setGuidance({ ...guidance, [role]: event.target.value })}
                        onBlur={() => {
                          if (designs && guidance[role] !== designs[role]?.guidance) void save(role, "guidance", guidance[role] ?? "");
                        }}
                      />
                    </Dictated>
                  </Row>
                </>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * Each stakeholder role's style guide: a PowerPoint whose theme its slides
 * follow — its accent and text colours, its title and body typefaces, and
 * its slide size. Templates are a shared library, uploaded once; a role
 * either points at one of them or keeps the plain default look.
 */
function DeckTemplates() {
  const [templates, setTemplates] = useState<DeckTemplate[] | null>(null);
  const [roles, setRoles] = useState<Record<string, string> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyRole, setBusyRole] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([api.listDeckTemplates(), api.deckSettings()]).then(([templatesResult, settingsResult]) => {
      setTemplates(templatesResult.templates);
      setRoles({ ...settingsResult.settings.roles });
    });

  useEffect(() => {
    let cancelled = false;
    load().catch((cause) => {
      if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      await api.uploadDeckTemplate(file);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (templateId: string) => {
    setRemovingId(templateId);
    setError(null);
    try {
      await api.removeDeckTemplate(templateId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setRemovingId(null);
    }
  };

  const mapRole = async (role: string, templateId: string | null) => {
    if (!roles) return;
    setBusyRole(role);
    setError(null);
    const before = roles;
    setRoles(
      templateId
        ? { ...roles, [role]: templateId }
        : Object.fromEntries(Object.entries(roles).filter(([key]) => key !== role)),
    );
    try {
      await api.setDeckTemplateForRole(role, templateId);
    } catch (cause) {
      setRoles(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <Section
      title="Stakeholder deck templates"
      lead="A PowerPoint whose theme a role's slides follow: its accent and text colours, its title and body typefaces, and its slide size. Nothing else is copied from it. Upload one below, then point a role at it."
    >
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        {(templates ?? []).map((template) => (
          <Row key={template.id} label={template.name}>
            <Button loading={removingId === template.id} onClick={() => void remove(template.id)}>
              Remove
            </Button>
          </Row>
        ))}
        <Row label="Upload" hint="A .pptx or .potx whose theme a role can follow">
          <label className="deck-template-pick">
            <input
              type="file"
              accept=".pptx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
            <span className="btn">{uploading ? "Uploading…" : "Choose a PowerPoint…"}</span>
          </label>
        </Row>
        {STAKEHOLDER_ROLES.map((role) => (
          <Row key={role} label={roleLabel(role)}>
            <select
              className="field"
              aria-label={`Style guide for ${roleLabel(role)}`}
              value={roles?.[role] ?? ""}
              disabled={!roles || !templates || busyRole === role}
              onChange={(event) => void mapRole(role, event.target.value || null)}
            >
              <option value="">Default look</option>
              {(templates ?? []).map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </Row>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------ this computer */

export function hostStatusCopy(status: HostStatus): string {
  const running = status.host.state === "ready" ? "Running" : status.host.state;
  const hub = status.hub.mode === "embedded" ? "embedded hub" : (status.hub.url ?? "remote hub");
  return `${running} · ${hub}`;
}

export function hostCredentialsCopy(status: HostStatus): string {
  return status.credentialBackend === "keychain" ? "macOS Keychain" : "private file on disk";
}

/**
 * Start-at-login is off until somebody turns it on, the copy says what it does
 * and does not do, and it says when the change takes effect rather than
 * implying it is already true. The desktop shell answers directly: outside it
 * there is no login item to point the switch at, so it stays disabled.
 */
function ThisComputer({ status }: { status: HostStatus | null }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inShell()) return;
    let cancelled = false;
    void invoke<boolean>("start_at_login")
      .then((value) => {
        if (!cancelled) setEnabled(value);
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
      await invoke("set_start_at_login", { enabled: next });
    } catch (cause) {
      setEnabled(!next);
      setError(String(cause));
    }
  };

  return (
    <Section title="This computer" lead="The host does the work. This window is only how you watch it.">
      <div className="section-body">
        {error ? <Banner tone="error" title={error} /> : null}
        {status ? (
          <Row label="Status">
            <span className="v">{hostStatusCopy(status)}</span>
          </Row>
        ) : null}
        {status ? (
          <Row label="Credentials">
            <span className="v">{hostCredentialsCopy(status)}</span>
          </Row>
        ) : null}
        {status ? (
          <Row label="Version">
            <span className="v">internal-beta</span>
          </Row>
        ) : null}
        <Row
          label="Start when you log in"
          hint="Keeps projects moving between the times you open this window. Applies from your next login. Never runs while the machine is asleep."
        >
          <Switch
            label="Start when you log in"
            checked={enabled ?? false}
            disabled={enabled === null}
            onCheckedChange={(next) => void toggle(next)}
          />
        </Row>
        {inShell() && status?.hub.mode === "embedded" ? (
          <Row label="Stop the host" hint="Closing the window only disconnects it. This ends the host, and everything in progress pauses until it starts again.">
            <Button variant="destructive" onClick={() => void invoke("quit_app")}>
              Stop
            </Button>
          </Row>
        ) : null}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- diagnostics */

function Diagnostics({ status }: { status: HostStatus | null }) {
  // The hub's health is this window's own read of it, not the host's relay.
  const [hubLive, setHubLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!status) return;
    let cancelled = false;
    void createHubTransport()
      .fetch("GET", "/status")
      .then(() => {
        if (!cancelled) setHubLive(true);
      })
      .catch(() => {
        if (!cancelled) setHubLive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);
  if (!status) return null;
  const capabilities = Object.entries(status.build?.capabilities ?? {});
  const hubCopy =
    hubLive === null
      ? "Checking…"
      : hubLive
        ? status.hub.mode === "embedded"
          ? "Embedded, in this app"
          : `Hosted at ${status.hub.url}`
        : status.hub.ready
          ? "The host mounted it, but it is not answering"
          : `Unavailable: ${status.hub.detail}`;
  return (
    <details className="section">
      <summary className="section-head">
        <h2>Diagnostics</h2>
        <p>For when something is wrong.</p>
      </summary>
      <div className="section-body">
        <Row label="Host">
          <span className="v">
            {status.host.state} · pid {status.host.pid} · since {new Date(status.host.startedAt).toLocaleString()}
          </span>
        </Row>
        {status.host.sleepGaps.length > 0 ? (
          <Row label="Not running">
            <span className="v">
              {status.host.sleepGaps
                .map(
                  (gap) =>
                    `${new Date(gap.from).toLocaleTimeString()}–${new Date(gap.to).toLocaleTimeString()} (${gap.seconds}s)`,
                )
                .join("; ")}
            </span>
          </Row>
        ) : null}
        <Row label="Hub">
          <span className="v">{hubCopy}</span>
        </Row>
        {status.build ? (
          <Row label="Build worker">
            <span className="v">
              {status.build.detail} ({capabilities.filter(([, ok]) => ok).length} of {capabilities.length} controls)
            </span>
          </Row>
        ) : null}
      </div>
    </details>
  );
}
