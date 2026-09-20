/**
 * Settings: four things a person can actually change.
 *
 *   1. Inference — which providers answer, in what order, with which model.
 *   2. Designer — the surface and design language it draws to, how much it
 *      may write, and what happens when a design is cut short.
 *   3. Build worker — which coding agent stage 8 runs, and where it is.
 *   4. This computer — whether the host starts at login, and stopping it.
 *   5. Diagnostics — folded away; for when something is wrong.
 *
 * The secret rule shows up in the markup: a key field is cleared the moment it
 * is handed over, and nothing ever renders it back. What the UI sees is a
 * status and a boolean.
 */
import { Input, Switch, Textarea } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { DECK_DENSITY, DECK_THEMES, DECK_TYPEFACES, DEFAULT_DECK_DESIGN, type DeckDensity, type DeckDesign, type DeckTheme, type DeckTypeface } from "@solutions-builder/app/deck";
import { api, ApiFailure, STAKEHOLDER_ROLES, type DesignerSettings, type HostStatus, type Provider } from "../client.js";
import { Banner, Button, StateLabel } from "../components.jsx";
import { deckDesignFor, guidanceFor } from "../deck-design-settings.ts";
import { Dictated } from "../dictation.jsx";
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
        providers={providers}
        apiKeyProviders={apiKeyProviders}
        oauthCandidates={oauthCandidates}
        onChanged={onChanged}
      />
      <Designer />
      <StakeholderDecks />
      <DeckTemplates />
      <BuildWorker status={status} onChanged={onChanged} />
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
  const active = providers.find((provider) => provider.active) ?? providers[0];
  const connected = providers.some((provider) => provider.status === "ready");
  return (
    <Section
      title="Inference"
      lead="The models that draft every stage. Connected providers are tried top to bottom; if the first cannot answer, the next one does, and each version records who wrote it."
      status={
        connected && active ? (
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
    <Section title="Designer" lead="What the stage-4 designer draws to, how much it may write, and what happens when that is not enough.">
      {error ? <Banner tone="error" title={error} /> : null}
      <div className="setting-row">
        <div>
          <strong>Surface</strong>
          <p>Light mockups sit beside the light documents. Dark is for products that are dark. Or leave it to what the brief calls for.</p>
        </div>
        <select
          className="setting-select"
          aria-label="Surface"
          value={settings?.surface ?? "light"}
          disabled={!settings}
          onChange={(event) => void save("surface", event.target.value as DesignerSettings["surface"])}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="brief">What the brief calls for</option>
        </select>
      </div>
      <div className="setting-field">
        <div>
          <strong>Design language</strong>
          <p>Palette, type, spacing, tone, what to avoid: anything the designer should follow, in your words. It takes precedence over the defaults. Saved when you leave the field.</p>
        </div>
        <Dictated value={language} onValueChange={setLanguage} disabled={!settings} align="start">
          <Textarea
            aria-label="Design language"
            value={language}
            disabled={!settings}
            placeholder="e.g. Inter for text, one accent colour, generous whitespace, no gradients, buttons with 6px corners."
            onChange={(event) => setLanguage(event.target.value)}
            onBlur={() => {
              if (settings && language !== settings.language) void save("language", language);
            }}
          />
        </Dictated>
      </div>
      <div className="setting-row">
        <div>
          <strong>Output limit</strong>
          <p>How many tokens one design may use, {TOKENS_MIN} to {TOKENS_MAX}. A full design usually needs 20,000 to 40,000 and takes five to ten minutes; a design that uses them all is cut short.</p>
        </div>
        <Input
          className="setting-number"
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
      </div>
      <div className="setting-row">
        <div>
          <strong>If a design exceeds the limit</strong>
          <p>Tell you and stop; raise the limit and try once more; or try once more at lower resolution within the limit, and tell you.</p>
        </div>
        <select
          className="setting-select"
          aria-label="If a design exceeds the limit"
          value={settings?.onLimit ?? "tell"}
          disabled={!settings}
          onChange={(event) => void save("onLimit", event.target.value as DesignerSettings["onLimit"])}
        >
          <option value="tell">Tell me and do nothing else</option>
          <option value="raise">Raise the limit and try again</option>
          <option value="reduce">Produce a lower-resolution design and tell me</option>
        </select>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------- deck templates */

type DeckTemplate = { id: string; name: string; mediaType: string; createdAt: string };

function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * How each stakeholder role's slides look, and what their deck outline
 * should emphasise. A changed look rebuilds the slides the next time they
 * are saved; changed guidance shapes the next package written for that
 * role. Selects and the notes switch save as they change; guidance saves
 * when the field is left, since it is typed. A mapped style guide (below)
 * takes precedence over the colour and typeface chosen here.
 */
function StakeholderDecks() {
  const [designs, setDesigns] = useState<Record<string, DeckDesign> | null>(null);
  const [guidance, setGuidance] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .preferences()
      .then(({ preferences }) => {
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

  const save = async <K extends keyof DeckDesign>(role: string, key: K, value: DeckDesign[K]) => {
    if (!designs) return;
    setError(null);
    const before = designs;
    setDesigns({ ...designs, [role]: { ...designs[role]!, [key]: value } });
    try {
      await api.setPreference(`deck.${role}.${key}`, value);
    } catch (cause) {
      setDesigns(before);
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  const saveGuidance = async (role: string) => {
    if (!designs || guidance[role] === designs[role]?.guidance) return;
    setError(null);
    try {
      await api.setPreference(`deck.${role}.guidance`, guidance[role] ?? "");
      setDesigns({ ...designs, [role]: { ...designs[role]!, guidance: guidance[role] ?? "" } });
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section
      title="Stakeholder decks"
      lead="How each stakeholder role's slides look, and what their deck outline should emphasise. Images are not yet drawn on this build: there is no image model path here, so that control is disabled."
    >
      {error ? <Banner tone="error" title={error} /> : null}
      {STAKEHOLDER_ROLES.map((role) => {
        const design = designs?.[role] ?? DEFAULT_DECK_DESIGN;
        const digest = [`${design.theme}, ${design.typeface}`, design.density, design.notes ? "notes" : "no notes"].join(" · ");
        return (
          <details key={role} className="deck-role">
            <summary className="deck-role-summary">
              <span className="deck-role-title">{roleLabel(role)}</span>
              <span className="deck-role-digest">{digest}</span>
            </summary>
            <div className="deck-role-body">
              <div className="deck-role-controls">
                <label className="deck-role-control">
                  <span>Colour</span>
                  <select
                    className="setting-select"
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
                </label>
                <label className="deck-role-control">
                  <span>Typeface</span>
                  <select
                    className="setting-select"
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
                </label>
                <label className="deck-role-control">
                  <span>Density</span>
                  <select
                    className="setting-select"
                    value={design.density}
                    disabled={!designs}
                    onChange={(event) => void save(role, "density", event.target.value as DeckDensity)}
                  >
                    <option value="sparse">Sparse · up to {DECK_DENSITY.sparse} points a slide</option>
                    <option value="standard">Standard · up to {DECK_DENSITY.standard}</option>
                    <option value="full">Full · up to {DECK_DENSITY.full}</option>
                  </select>
                </label>
                <label className="deck-role-control">
                  <span>Speaker notes</span>
                  <Switch checked={design.notes} disabled={!designs} onCheckedChange={(checked) => void save(role, "notes", checked)} />
                </label>
                <label className="deck-role-control">
                  <span>Images</span>
                  <select className="setting-select" value="none" disabled title="No image model is connected on this build yet.">
                    <option value="none">None (no image model yet)</option>
                  </select>
                </label>
              </div>
              <div className="setting-field">
                <div>
                  <strong>What the outline should emphasise</strong>
                  <p>In your words, for this role: what to lead with, what to leave out, the tone. Given to the presentation creator with the next package.</p>
                </div>
                <Dictated value={guidance[role] ?? ""} onValueChange={(next) => setGuidance({ ...guidance, [role]: next })} disabled={!designs} align="start">
                  <Textarea
                    aria-label={`Deck guidance for ${roleLabel(role)}`}
                    value={guidance[role] ?? ""}
                    disabled={!designs}
                    placeholder="e.g. Lead with cost and timeline; one risk slide at most; no implementation detail."
                    onChange={(event) => setGuidance({ ...guidance, [role]: event.target.value })}
                    onBlur={() => void saveGuidance(role)}
                  />
                </Dictated>
              </div>
            </div>
          </details>
        );
      })}
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
      {error ? <Banner tone="error" title={error} /> : null}
      <div className="deck-template-library">
        {(templates ?? []).map((template) => (
          <div key={template.id} className="deck-template-row">
            <span className="deck-template-name">{template.name}</span>
            <Button loading={removingId === template.id} onClick={() => void remove(template.id)}>
              Remove
            </Button>
          </div>
        ))}
        <label className="deck-template-pick">
          <Input
            type="file"
            accept=".pptx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <span>{uploading ? "Uploading…" : "Choose a PowerPoint…"}</span>
        </label>
      </div>
      {STAKEHOLDER_ROLES.map((role) => (
        <div key={role} className="setting-row">
          <div>
            <strong>{roleLabel(role)}</strong>
          </div>
          <select
            className="setting-select"
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
        </div>
      ))}
    </Section>
  );
}

/* ------------------------------------------------------------- build worker */

/**
 * Which coding agent stage 8 hands the frozen packet to. The bridge runs one
 * tool's non-interactive form and reports final text and an exit status
 * whichever it is; the choice here changes the tool, not what the bridge can
 * see. Availability is the host's word, refreshed with its status, so a
 * change shows its consequence here before anyone reaches stage 8.
 */
function BuildWorker({ status, onChanged }: { status: HostStatus | null; onChanged: () => void }) {
  const [worker, setWorker] = useState<string | null>(null);
  const [executable, setExecutable] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const workers = status?.build?.workers ?? [];
  const chosen = workers.find((entry) => entry.id === worker);

  useEffect(() => {
    let cancelled = false;
    void api
      .preferences()
      .then(({ preferences }) => {
        if (cancelled) return;
        setWorker(String(preferences["build.worker"] ?? "corbits-code"));
        const path = String(preferences["build.executable"] ?? "");
        setExecutable(path);
        setSaved(path);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (key: "worker" | "executable", value: string) => {
    setError(null);
    try {
      await api.setPreference(`build.${key}`, value);
      if (key === "executable") setSaved(value);
      // The host's status carries the new worker's availability; asked for
      // now rather than at the next five-second refresh.
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return (
    <Section
      title="Build worker"
      lead="The coding agent stage 8 hands the frozen packet to. It runs on this computer, with your own configuration of that tool."
      status={
        status?.build ? (
          <StateLabel tone={status.build.available ? "success" : "error"}>
            {status.build.available ? "Available" : "Unavailable"}
          </StateLabel>
        ) : null
      }
    >
      {error ? <Banner tone="error" title={error} /> : null}
      <div className="setting-row">
        <div>
          <strong>Tool</strong>
          <p>Corbits Code is the default. Whichever you choose, the build shows its final output and exit status and nothing more.</p>
        </div>
        <select
          className="setting-select"
          aria-label="Build worker"
          value={worker ?? "corbits-code"}
          disabled={worker === null || workers.length === 0}
          onChange={(event) => {
            setWorker(event.target.value);
            void save("worker", event.target.value);
          }}
        >
          {workers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div>
          <strong>Executable</strong>
          <p>Leave empty to use <code>{chosen?.executable ?? "the tool's own name"}</code> from this computer's PATH. Give a full path for an install that is somewhere else. Saved when you leave the field.</p>
        </div>
        <Dictated value={executable} onValueChange={setExecutable} disabled={worker === null} align="center">
        <Input
          className="setting-path"
          aria-label="Build worker executable"
          type="text"
          value={executable}
          disabled={worker === null}
          placeholder={chosen?.executable ?? ""}
          spellCheck={false}
          onChange={(event) => setExecutable(event.target.value)}
          onBlur={() => {
            if (executable.trim() !== saved) void save("executable", executable.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
        />
        </Dictated>
      </div>
      {status?.build ? <p className="setting-note">{status.build.detail}</p> : null}
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
  const capabilities = Object.entries(status.build?.capabilities ?? {});
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
        {status.build ? (
          <div>
            <dt>Build worker</dt>
            <dd>
              {status.build.detail} ({capabilities.filter(([, ok]) => ok).length} of {capabilities.length} controls)
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
