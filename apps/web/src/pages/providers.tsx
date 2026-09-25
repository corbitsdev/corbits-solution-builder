/**
 * The provider list, shared by onboarding and Settings so the two cannot
 * drift. One row per way in. A row that is not connected offers exactly one
 * action, named after how it connects; a row that is connected shows what it
 * serves and, on Settings, lets the model list be refreshed in place. Model
 * default, fallback order and restrictions live on `ResolvedCatalogList`,
 * which is not mounted on the Settings page.
 *
 * Keys are asked for on the row that was clicked and cleared the moment they
 * are handed over. Nothing here ever renders a secret back.
 *
 * Connecting and refreshing drive the hub's
 * own catalog routes directly (`client.ts` -> `provider-catalog.ts` ->
 * `@solutions-builder/installer`); an OAuth provider signs in through the
 * loopback the embedded hub mounts on `@corbits/oauth-core`
 * (`packages/embed-hub/src/oauth-mount.ts`).
 *
 * Markup is the Settings mockup's `.row` / `.k` / `.v` language: Connect is
 * an outline `.btn`, a live connection is muted "Connected" plus Refresh
 * models, and catalog actions are quiet links in `.v`.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { api, ApiFailure, type Provider, type ResolvedCatalogRow } from "../client.js";
import { blocksCollide, dropOn, moveBy, moveTo, rankLabel, sameOrder } from "./provider-order.ts";
import { LOCAL_DEFAULT_BASE_URL, LOCAL_PROVIDER_ID } from "../provider-catalog.js";
import { Banner } from "../components.jsx";
import { Dictated } from "../dictation.jsx";

export type ApiKeyProvider = { providerId: string; label: string; needsBaseUrl: boolean };
export type OAuthCandidate = { providerId: string; label: string; redirectUri: string };

type Row = {
  id: string;
  name: string;
  how: string;
  kind: "oauth" | "api_key" | "local_endpoint";
  action: "Log in with subscription" | "Connect API key" | "Connect locally";
  needsBaseUrl: boolean;
};

function ChromeBtn({
  kind = "outline",
  loading,
  children,
  type = "button",
  disabled,
  onClick,
  title,
  "aria-label": ariaLabel,
}: {
  kind?: "outline" | "link" | "refresh";
  loading?: boolean;
  children: ReactNode;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  "aria-label"?: string;
}) {
  const className = kind === "refresh" ? "refresh-models" : kind === "link" ? "btn link" : "btn";
  return (
    <button
      type={type}
      className={className}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
    >
      {loading && kind === "refresh" ? "Refreshing…" : children}
    </button>
  );
}

export function ProviderList({
  providers,
  apiKeyProviders,
  oauthCandidates,
  onChanged,
  manage = false,
}: {
  providers: Provider[];
  apiKeyProviders: ApiKeyProvider[];
  oauthCandidates: OAuthCandidate[];
  /** Called after any successful change; the parent refetches. */
  onChanged: () => Promise<void> | void;
  /** Settings' connections subsection shows Refresh models; onboarding does not. */
  manage?: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const cancelledRef = useRef<Set<string>>(new Set());

  const rows: Row[] = [
    ...oauthCandidates.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      how: "Use a subscription you already pay for.",
      kind: "oauth" as const,
      action: "Log in with subscription" as const,
      needsBaseUrl: false,
    })),
    ...apiKeyProviders.map((entry) => ({
      id: entry.providerId,
      name: entry.label,
      how: "Kept in the keychain. Never shown again.",
      kind: "api_key" as const,
      action: "Connect API key" as const,
      needsBaseUrl: entry.needsBaseUrl,
    })),
    // Last: the option that needs no account and no key.
    {
      id: LOCAL_PROVIDER_ID,
      name: "Ollama",
      how: "Runs on this machine. No account, no key.",
      kind: "local_endpoint" as const,
      action: "Connect locally" as const,
      needsBaseUrl: true,
    },
  ];

  const connectedFor = (row: Row) => providers.find((provider) => provider.providerId === row.id);

  // Settings: the connected providers are one list, most preferred first,
  // that the person orders by dragging a row's handle (or with the arrow
  // keys on it); the head is where the default model comes from, since a
  // saved order re-bases every provider's offering priorities behind it.
  // The unconnected ones wait below. Onboarding keeps the catalog's order.
  const [order, setOrder] = useState<string[]>(() => providers.map((provider) => provider.id));
  useEffect(() => {
    const fresh = providers.map((provider) => provider.id);
    setOrder((current) => (sameOrder(current, fresh) ? current : fresh));
  }, [providers]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Each row is one combination, a provider and the model it tries, and the
  // rows are the failover chain: the head is the default and is tried first,
  // each row below is tried if the one above fails. Two things the stored
  // catalog can drift from that are settled once, on view: providers
  // connected before any order was saved share block 0 (so what the list
  // shows first and what the catalog picks can differ), and a provider
  // never chosen for still has every model enabled (so the chain would try
  // all of them before the next row). Saving the order as shown, and
  // restricting each such provider to the model its row shows, makes the
  // chain exactly the list.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!manage || settledRef.current || busy !== null || providers.length === 0) return;
    const unrestricted = providers.filter((provider) => provider.enabledModels.length > 1 && provider.selectedModel !== null);
    const collide = providers.length > 1 && blocksCollide(providers);
    if (!collide && unrestricted.length === 0) return;
    settledRef.current = true;
    void act("order", async () => {
      if (collide) await api.reorderProviders(providers.map((provider) => provider.id));
      for (const provider of unrestricted) await api.selectProviderModel(provider.id, provider.selectedModel);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage, providers]);
  const connectedRows = manage
    ? order.map((id) => rows.find((row) => connectedFor(row)?.id === id)).filter((row): row is Row => row !== undefined)
    : [];
  const otherRows = manage ? rows.filter((row) => !connectedFor(row)) : rows;
  const listRows = [...connectedRows, ...otherRows];
  const dividerBefore = manage && connectedRows.length > 0 && otherRows.length > 0 ? otherRows[0]!.id : null;

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    cancelledRef.current.delete(id);
    try {
      await work();
      if (cancelledRef.current.has(id)) return;
      if (done) setNotice(done);
      await onChanged();
    } catch (cause) {
      if (cancelledRef.current.has(id)) return;
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!cancelledRef.current.has(id)) setBusy(null);
    }
  };

  const persistOrder = (next: string[]) => {
    if (sameOrder(next, order)) return;
    setOrder(next);
    const head = rows.find((row) => connectedFor(row)?.id === next[0]);
    void act(
      "order",
      () => api.reorderProviders(next),
      head ? `${head.name} is tried first now. Applies to stages that start from now on.` : "Order saved.",
    );
  };

  const connect = (row: Row) =>
    act(row.id, async () => {
      if (row.kind === "oauth") {
        await api.connectOAuthProvider({ providerId: row.id, label: row.name }, (url) => {
          if (!cancelledRef.current.has(row.id)) setAuthorizeUrl(url);
        });
        // No pin: the workspace default is the priority-first enabled model
        // (CL-8781), derived at read time — nothing to write at connect time.
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
    setNotice(null);
    // Stop the host's callback server too: it holds a fixed loopback port, so
    // leaving it running makes the next attempt fail as "already in use".
    void api.cancelProviderSignIn(id).catch(() => undefined);
  };

  const canSave = (row: Row) => {
    if (busy !== null) return false;
    if (row.kind === "local_endpoint") return baseUrl.trim().length > 0;
    return secret.trim().length > 0 && (!row.needsBaseUrl || baseUrl.trim().length > 0);
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

      {listRows.map((row) => {
        const connected = connectedFor(row);
        const ready = connected?.status === "ready";
        const asking = chosen === row.id;
        const waiting = busy === row.id && row.kind === "oauth";
        const sortable = manage && connected !== undefined && ready;
        const rank = sortable ? rankLabel(order.indexOf(connected.id), connected.selectedModel !== null) : null;
        const rowClass = [
          "row",
          sortable && dragging === connected.id ? "is-dragging" : null,
          sortable && over === connected.id && dragging !== connected.id ? "is-drop-target" : null,
        ]
          .filter(Boolean)
          .join(" ");
        const hint = connected
          ? ready
            ? describeConnected(connected)
            : (connected.statusDetail ?? connected.status)
          : waiting
            ? "Waiting for the browser"
            : row.how;
        return (
          <div key={row.id} className="contents">
            {dividerBefore === row.id ? (
              <div className="row row-divider">
                <div className="k">
                  <span>Not connected</span>
                </div>
              </div>
            ) : null}
          <div
            className={rowClass}
            onDragOver={(event) => {
              if (!sortable || dragging === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (over !== connected.id) setOver(connected.id);
            }}
            onDragLeave={() => {
              if (sortable && over === connected.id) setOver(null);
            }}
            onDrop={(event) => {
              if (!sortable || dragging === null) return;
              event.preventDefault();
              persistOrder(dropOn(order, dragging, connected.id));
              setDragging(null);
              setOver(null);
            }}
          >
            {sortable ? (
              <button
                type="button"
                className="drag-handle"
                draggable
                aria-label={`Reorder ${row.name}`}
                title="Drag to change the order tried. Arrow keys move it; Home puts it first."
                disabled={busy !== null}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", connected.id);
                  setDragging(connected.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    persistOrder(moveBy(order, connected.id, -1));
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    persistOrder(moveBy(order, connected.id, 1));
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    persistOrder(moveTo(order, connected.id, 0));
                  }
                }}
              >
                <GripVertical size={14} aria-hidden="true" />
              </button>
            ) : null}
            <div className="k">
              <b>
                {row.name}
                {rank ? <em className={rank.startsWith("Default") ? "default-mark" : "fallback-mark"}>{rank}</em> : null}
                {sortable && !rank ? <em className="fallback-mark">No model enabled · skipped</em> : null}
              </b>
              <span>{hint}</span>
            </div>

            {asking ? (
              <form
                className="v"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSave(row)) void connect(row);
                }}
              >
                {row.needsBaseUrl ? (
                  <Dictated value={baseUrl} onValueChange={setBaseUrl} align="center">
                    <input
                      className="field"
                      type="text"
                      autoFocus={row.kind === "local_endpoint"}
                      placeholder={row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "https://example.com/v1"}
                      aria-label="Endpoint"
                      autoComplete="off"
                      spellCheck={false}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          closeAsk();
                        }
                      }}
                    />
                  </Dictated>
                ) : null}
                {row.kind === "api_key" ? (
                  <input
                    className="field"
                    type="password"
                    autoFocus={!row.needsBaseUrl}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder={`${row.name} API key`}
                    aria-label={`${row.name} API key`}
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        closeAsk();
                      }
                    }}
                  />
                ) : null}
                <ChromeBtn type="submit" loading={busy === row.id} disabled={!canSave(row)}>
                  Save
                </ChromeBtn>
                <ChromeBtn kind="link" onClick={closeAsk}>
                  Cancel
                </ChromeBtn>
              </form>
            ) : waiting ? (
              <span className="v">
                Waiting for the browser
                <ChromeBtn onClick={() => cancelSignIn(row.id)}>Cancel</ChromeBtn>
              </span>
            ) : connected && ready ? (
              <span className="v">
                {manage && connected.models.length > 1 ? (
                  // The model this row tries. Choosing one restricts the
                  // provider to it, so the chain moves on to the next row
                  // rather than through the provider's other models.
                  <select
                    className="field"
                    aria-label={`${row.name} model`}
                    disabled={busy !== null}
                    value={connected.selectedModel ?? connected.models[0] ?? ""}
                    onChange={(event) => {
                      const model = event.target.value;
                      if (!model) return;
                      void act(row.id, () => api.selectProviderModel(connected.id, model), `${row.name} now tries ${model}.`);
                    }}
                  >
                    {connected.models.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : manage && connected.models.length === 1 ? (
                  <span className="model-name">{connected.models[0]}</span>
                ) : null}
                {manage ? (
                  <ChromeBtn
                    kind="refresh"
                    title="Re-pull the model list"
                    disabled={busy !== null}
                    loading={busy === row.id}
                    onClick={() =>
                      void act(
                        row.id,
                        async () => {
                          await api.refreshProviderModels(connected.id);
                        },
                        `${row.name} models refreshed.`,
                      )
                    }
                  >
                    Refresh models
                  </ChromeBtn>
                ) : null}
                Connected
              </span>
            ) : (
              <span className="v">
                {connected && !ready ? "Needs attention" : null}
                <ChromeBtn
                  loading={busy === row.id}
                  disabled={busy !== null}
                  aria-label={row.action}
                  onClick={() => {
                    if (row.kind === "oauth") void connect(row);
                    else {
                      setChosen(row.id);
                      setSecret("");
                      setBaseUrl(row.kind === "local_endpoint" ? LOCAL_DEFAULT_BASE_URL : "");
                    }
                  }}
                >
                  {connected ? "Reconnect" : "Connect"}
                </ChromeBtn>
              </span>
            )}
          </div>
          </div>
        );
      })}

      {/* Below the list, always. An error above it would move the thing the
          person was about to click. */}
      {error ? <Banner tone="error" title={error} /> : null}
      {notice ? <Banner tone="okay" title={notice} /> : null}

      {rows.find((row) => row.id === chosen)?.kind === "local_endpoint" ? (
        <p className="inline-note">
          Ollama's default. Change it for LM Studio, vLLM or another OpenAI-compatible server.
        </p>
      ) : null}
    </>
  );
}

/** What a connected row says under its name: models on the connection and when it was last checked. */
function describeConnected(provider: Provider): string {
  const parts: string[] = [];
  parts.push(`${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`);
  if (provider.validatedAt) parts.push(`checked ${ago(provider.validatedAt)}`);
  return parts.join(" · ");
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The resolved catalog (CL-8782): one row per model in fallback order from
 * `GET /api/tenants/:id/models`, with the default, reorder, restrict and
 * shadow controls. Restricted rows stay visible with a muted label -- never
 * default candidates. Non-chat rows are labelled and can never be the chat
 * default. The credential readout is boolean only; the per-row link jumps to
 * the connections list above. Every write goes through the existing catalog
 * routes; an empty catalog renders an explicit empty state, never simulated
 * rows.
 */
export function ResolvedCatalogList({
  providers,
  onChanged,
}: {
  /** Parent's provider list: a new identity refetches, so connection changes below refresh these rows. */
  providers: Provider[];
  /** Called after any successful change; the parent refetches. */
  onChanged: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<ResolvedCatalogRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await api.resolvedCatalog());
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, providers]);

  const act = async (id: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await reload();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (rows === null) return <p className="inline-note">Loading models…</p>;

  return (
    <>
      {rows.length === 0 ? (
        <p className="inline-note">
          No models resolved yet. Connect a provider — the catalog appears here in fallback order.
        </p>
      ) : (
        rows.map((row, index) => {
          const name = row.displayName ?? row.canonicalName;
          const movable = !row.restricted;
          const flags = [
            row.isDefault ? "Default" : null,
            row.restricted ? "Restricted" : null,
            row.shadowed ? "Shadowed" : null,
            !row.chatCapable ? "Not chat" : null,
          ].filter((flag): flag is string => flag !== null);
          return (
            <div key={row.modelId} className="row">
              <div className="k">
                <b>{name}</b>
                <span>{describeResolvedRow(row, index)}</span>
              </div>
              <span className="v">
                {flags.length > 0 ? flags.join(" · ") : null}
                {row.defaultCandidate && !row.isDefault ? (
                  <ChromeBtn
                    kind="link"
                    disabled={busy !== null}
                    loading={busy === `default:${row.modelId}`}
                    onClick={() => void act(`default:${row.modelId}`, () => api.makeResolvedDefault(row.modelId), `${name} is now the default.`)}
                  >
                    Make default
                  </ChromeBtn>
                ) : null}
                {movable ? (
                  <>
                    <ChromeBtn
                      kind="link"
                      disabled={busy !== null || index <= 0}
                      onClick={() => void act(`move:${row.modelId}`, () => api.moveResolvedModel(row.modelId, "up"))}
                    >
                      Move up
                    </ChromeBtn>
                    <ChromeBtn
                      kind="link"
                      disabled={busy !== null || index >= rows.length - 1}
                      onClick={() => void act(`move:${row.modelId}`, () => api.moveResolvedModel(row.modelId, "down"))}
                    >
                      Move down
                    </ChromeBtn>
                  </>
                ) : null}
                <ChromeBtn
                  kind="link"
                  disabled={busy !== null}
                  loading={busy === `restrict:${row.modelId}`}
                  onClick={() =>
                    void act(
                      `restrict:${row.modelId}`,
                      () => api.setResolvedRestricted(row.modelId, !row.restricted),
                      row.restricted ? `${name} unrestricted.` : `${name} restricted.`,
                    )
                  }
                >
                  {row.restricted ? "Unrestrict" : "Restrict"}
                </ChromeBtn>
                {row.providerRowIds.length > 0 ? (
                  <ChromeBtn
                    kind="link"
                    disabled={busy !== null}
                    loading={busy === `shadow:${row.modelId}`}
                    onClick={() =>
                      void act(
                        `shadow:${row.modelId}`,
                        () => api.setResolvedShadowed(row.providerRowIds, !row.shadowed),
                        row.shadowed ? `${name} unshadowed.` : `${name} shadowed.`,
                      )
                    }
                  >
                    {row.shadowed ? "Unshadow" : "Shadow"}
                  </ChromeBtn>
                ) : null}
                <a className="btn link" href="#connections">
                  {row.credentialConnected ? "Key on file · Manage connection" : "No key · Manage connection"}
                </a>
              </span>
            </div>
          );
        })
      )}
      {error ? <Banner tone="error" title={error} /> : null}
      {notice ? <Banner tone="okay" title={notice} /> : null}
    </>
  );
}

/** What a resolved row says under its name: fallback rank, serving providers, and model count position. */
export function describeResolvedRow(row: ResolvedCatalogRow, position: number): string {
  const parts: string[] = [];
  if (!row.restricted && row.chatCapable) {
    parts.push(position === 0 ? "Answers first" : `Fallback ${position}`);
  }
  if (row.providerNames.length > 0) parts.push(`via ${row.providerNames.join(", ")}`);
  parts.push(row.canonicalName);
  return parts.join(" · ");
}
