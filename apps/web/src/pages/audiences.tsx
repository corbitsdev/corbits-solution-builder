/**
 * Stage 5 — one package per named audience.
 *
 * The per-stakeholder quorum decision (`audience.decide`, recorded against a
 * parked ledger run) has no mail-agent-shaped replacement yet — CL-8612
 * contract v6 has no lifecycle run to park a decision on. This surface is
 * pared down to writing and reviewing packages; advancing past the stage is
 * the same "Approve and continue" the other stages use
 * (`pages/workspace/index.tsx`). Recording each stakeholder's own decision
 * is filed as a follow-up (CL-8625).
 */
import { useEffect, useState } from "react";
import { api, ApiFailure, type ProjectDetail } from "../client.js";
import { Banner, Button, Field, Screen, StateLabel, versionDigest } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { Tabs, Input } from "@corbits/react-ui";
import { Markdown } from "../markdown.jsx";

type Policy = { audiences?: { name: string; role: string }[]; audienceQuorum?: number };

/** A role's name as a person reads it. */
/** The person's own entry — the stakeholder named "You" — ahead of everyone else, the rest as listed. */
function youFirst<T extends { name: string }>(list: readonly T[]): T[] {
  const isYou = (entry: T) => entry.name.trim().toLowerCase() === "you";
  return [...list.filter(isYou), ...list.filter((entry) => !isYou(entry))];
}

function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * Who the packages are for. Each row is a name and a role; the quorum is how
 * many proceeds approve the stage. Saved as a whole, since the list and the
 * quorum only make sense together, and the lifecycle is rendered again from
 * the new list on the next draft.
 */
function Stakeholders({
  projectId,
  audiences,
  quorum,
  onChanged,
}: {
  projectId: string;
  audiences: { name: string; role: string }[];
  quorum: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState(audiences);
  const [needed, setNeeded] = useState(quorum);
  const [roles, setRoles] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.stakeholders(projectId).then((result) => setRoles(result.roles)).catch(() => setRoles([]));
  }, [projectId]);
  useEffect(() => {
    if (!editing) {
      setRows(audiences);
      setNeeded(quorum);
    }
  }, [audiences, quorum, editing]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setStakeholders(projectId, { audiences: rows, audienceQuorum: needed });
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Stakeholders"
      description="Who each package is written for, and who records a decision on it."
      status={<StateLabel tone="info">{audiences.length} named · {quorum} must proceed</StateLabel>}
      tight
    >
      {error ? <Banner tone="error" title={error} /> : null}
      {editing ? (
        <div className="screen-body stakeholder-editor">
          {rows.map((row, index) => (
            <div key={index} className="stakeholder-row">
              <Dictated
                value={row.name}
                onValueChange={(name) => setRows(rows.map((held, at) => (at === index ? { ...held, name } : held)))}
                align="center"
              >
                <Input
                  aria-label={`Stakeholder ${index + 1} name`}
                  value={row.name}
                  placeholder="Name"
                  onChange={(event) => setRows(rows.map((held, at) => (at === index ? { ...held, name: event.target.value } : held)))}
                />
              </Dictated>
              <select
                aria-label={`Stakeholder ${index + 1} role`}
                value={row.role}
                onChange={(event) => setRows(rows.map((held, at) => (at === index ? { ...held, role: event.target.value } : held)))}
              >
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, at) => at !== index))}>
                Remove
              </Button>
            </div>
          ))}
          <div className="button-row">
            <Button onClick={() => setRows([...rows, { name: "", role: "audience_member" }])}>Add a stakeholder</Button>
          </div>
          <Field label="How many must proceed for the stage to be approved">
            <Input
              className="setting-number"
              type="number"
              inputMode="numeric"
              min={0}
              max={rows.length}
              value={String(needed)}
              onChange={(event) => setNeeded(Number(event.target.value))}
            />
          </Field>
          <p className="inline-note">
            The next draft writes one package per stakeholder. Decisions already recorded stay recorded.
          </p>
          <div className="button-row">
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Save stakeholders
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="screen-body">
          <ul className="stakeholder-list">
            {audiences.map((audience) => (
              <li key={audience.name}>
                <strong>{audience.name}</strong> · {roleLabel(audience.role)}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <Button onClick={() => setEditing(true)}>Edit stakeholders…</Button>
          </div>
        </div>
      )}
    </Screen>
  );
}

export function AudiencePackages({
  detail,
  tenantId,
  onChanged,
  drafting,
  onDraftPackages,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  /** A round is under way: the rows say so instead of offering another. */
  drafting: boolean;
  /** Writes these stakeholders' packages, by name, leaving the others as they are. */
  onDraftPackages: (audiences: string[]) => void;
}) {
  const policy = (detail.project.policy ?? {}) as Policy;
  const audiences = youFirst(policy.audiences ?? []);
  const quorum = policy.audienceQuorum ?? 0;

  // Packages in the stakeholders' order, so the tabs and the decisions
  // table read the same way, with the person's own first.
  const rank = (name: string | null) => {
    const index = audiences.findIndex((audience) => audience.name === name);
    return index === -1 ? audiences.length : index;
  };
  const packages = detail.nodes
    .filter((node) => node.kind === "audience_package" && node.supersededByNodeId === null)
    .sort((a, b) => rank(a.variant) - rank(b.variant));
  // The open tab is a stakeholder, not a version: writing a package again
  // gives it a new version id, and a tab keyed on the id fell back to the
  // first stakeholder the moment the rewrite landed.
  const [active, setActive] = useState<string | null>(packages[0]?.variant ?? null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Slides are asked for one audience at a time, and a person moves on to
  // the next while the first is still being saved. So each package keeps
  // its own state — being saved, or where its slides went — rather than one
  // slot for whichever tab happens to be open.
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [savedPaths, setSavedPaths] = useState<ReadonlyMap<string, string>>(new Map());
  // The slides for a package are the PowerPoint stage 5 already recorded
  // beside it. Saving writes those bytes; the host does not build a deck.
  const saveSlides = async (packageNodeId: string) => {
    setSaving((before) => new Set(before).add(packageNodeId));
    setError(null);
    try {
      const result = await api.saveSlidesFor(packageNodeId);
      setSavedPaths((before) => new Map(before).set(packageNodeId, result.path));
    } catch (cause) {
      const name = packages.find((node) => node.id === packageNodeId)?.variant ?? "this stakeholder";
      setError(`Slides for ${name}: ${cause instanceof ApiFailure ? cause.detail.message : String(cause)}`);
    } finally {
      setSaving((before) => {
        const next = new Set(before);
        next.delete(packageNodeId);
        return next;
      });
    }
  };
  const slidesState = (nodeId: string): "saving" | "saved" | null =>
    saving.has(nodeId) ? "saving" : savedPaths.has(nodeId) ? "saved" : null;

  const selected = packages.find((node) => node.variant === active) ?? packages[0] ?? null;
  // A stakeholder whose package was never written, or failed to be: the
  // round writes the ones it can and reports the rest, so these are offered
  // one by one rather than the whole stage again.
  const missing = audiences.filter((audience) => !packages.some((node) => node.variant === audience.name));

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    let cancelled = false;
    void api.artifactContent(tenantId, selected.id).then((result) => {
      if (!cancelled) setContent(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, tenantId]);

  return (
    <>
      <Stakeholders projectId={detail.project.id} audiences={audiences} quorum={quorum} onChanged={onChanged} />
      <div data-tour="audience-packages">
      <Screen
        title="Stakeholder packages"
        description="Rough cost, not the firm estimate."
        status={
          missing.length === 0 && packages.length > 0 ? (
            <StateLabel tone="success">Every stakeholder has a package</StateLabel>
          ) : (
            <StateLabel tone="warning">{missing.length} still missing</StateLabel>
          )
        }
      >
        {error ? <Banner tone="error" title="That decision was refused">{error}</Banner> : null}

        {audiences.length === 0 ? (
          <Banner title="No stakeholders are named for this project" />
        ) : null}

        {missing.length > 0 ? (
          <div className="packages-missing" role="status">
            <p className="packages-missing-title">
              {packages.length === 0
                ? "No packages yet."
                : missing.length === 1
                  ? "One stakeholder has no package yet."
                  : `${missing.length} stakeholders have no package yet.`}
            </p>
            <ul className="packages-missing-list">
              {missing.map((audience) => (
                <li key={audience.name}>
                  <span>
                    <strong>{audience.name}</strong> · {roleLabel(audience.role)}
                  </span>
                  <Button loading={drafting} onClick={() => onDraftPackages([audience.name])}>
                    Write it
                  </Button>
                </li>
              ))}
            </ul>
            {missing.length > 1 ? (
              <Button
                variant="primary"
                loading={drafting}
                onClick={() => onDraftPackages(missing.map((audience) => audience.name))}
              >
                Write all {missing.length}
              </Button>
            ) : null}
          </div>
        ) : null}

        {packages.length === 0 ? null : (
          <>
            {/* One tab per audience package. */}
            <Tabs
              label="Stakeholder packages"
              active={selected?.variant ?? ""}
              onChange={setActive}
              tabs={packages.map((node) => ({
                id: node.variant ?? node.id,
                // The tab says where its slides stand, so the person need
                // not come back to each one to find out.
                label: `${node.variant ?? node.title}${
                  slidesState(node.id) === "saving" ? " · saving slides…" : slidesState(node.id) === "saved" ? " · slides saved" : ""
                }`,
              }))}
            >
              {() => null}
            </Tabs>
            {saving.size > 0 ? (
              <p className="inline-note" aria-live="polite">
                Saving slides for {packages.filter((node) => saving.has(node.id)).map((node) => node.variant ?? node.title).join(", ")}.
                Keep going; each tab says when its slides are saved.
              </p>
            ) : null}

            {selected ? (
              <>
                {/* The package itself stays folded: one line says which
                    version this is and when it was written, and opening it
                    shows the report. The fold is one element across the
                    tabs, so it stays open while reading several in turn. */}
                <details className="document-fold">
                  <summary className="document-fold-summary">
                    <span className="document-fold-title">{selected.title}</span>
                    <span className="document-fold-digest">{versionDigest(selected)}</span>
                  </summary>
                  <div className="document-body document-fold-body">
                    {content ? (
                      <Markdown source={content} />
                    ) : (
                      <p className="inline-note">Loading…</p>
                    )}
                  </div>
                </details>
                {savedPaths.has(selected.id) ? (
                  <Banner
                    tone="okay"
                    title={`Saved to ${savedPaths.get(selected.id)}`}
                    action={{
                      label: "Dismiss",
                      onClick: () =>
                        setSavedPaths((before) => {
                          const next = new Map(before);
                          next.delete(selected.id);
                          return next;
                        }),
                    }}
                  />
                ) : null}
                {/* The slides built from this package's deck outline, and,
                    while the stage is open, a way to write the package again
                    on its own; the others keep their versions and decisions. */}
                <div className="button-row">
                  <Button variant="primary" loading={saving.has(selected.id)} onClick={() => saveSlides(selected.id)}>
                    {saving.has(selected.id) ? "Saving slides…" : "Save slides (.pptx)"}
                  </Button>
                  {selected.variant ? (
                    <Button loading={drafting} onClick={() => onDraftPackages([selected.variant!])}>
                      Write this package again
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </Screen>
      </div>
    </>
  );
}
