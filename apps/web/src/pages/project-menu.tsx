/**
 * A project's options menu (#323), the same wherever a project is named: the
 * card on the projects page and the title in the workspace's top-left
 * corner. Info, rename, settings, the finished documents as one zip, the
 * bundle for re-import, archive, prune, repair, and a two-step delete. The
 * dialogs it opens live here too, so the menu is complete on its own.
 *
 * The card's face opens the project on click and long-press, so a host
 * that needs to know when the menu or a dialog is up, or that a press just
 * dismissed the menu, gets told through the callbacks; the title has no such
 * face and ignores them.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@corbits/react-ui";
import { useEffect, useState, type ReactElement } from "react";
import { api, ApiFailure, type ActiveModel, type ProjectInfo } from "../client.js";
import { Banner, Button, downloadArtifact, stageName } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { downloadProjectDocuments, saveBlob } from "../documents-archive.ts";
import { assembleBundle, bundleFileName } from "../project-export.js";
import { formatUsage } from "../project-usage.js";
import { ProjectSettingsDialog } from "./project-settings.jsx";
import { prunePlanSummary, type PrunePlan } from "../prune-versions.ts";

/** What the menu needs of a project: the card's summary and the workspace's detail both have it. */
export type MenuProject = { id: string; title: string; archivedAt: string | null };

/** A request from outside the menu to open the info dialog: the card's context menu and long-press. */
export type InfoRequest = { withName: boolean; at: number };

/**
 * Exports one project the way this lane can: the bundle is assembled in the
 * browser (`assembleBundle`) and saved as a download. Returns the notice
 * line; shared by the options menu and the Project info dialog.
 */
export async function exportProjectBundle(project: MenuProject): Promise<string> {
  const bundle = await assembleBundle(project.id, {
    projectView: api.projectView,
    artifactContent: api.artifactContent,
    stageAgentAddresses: api.stageAgentAddresses,
    readStageThread: api.readStageThread,
  });
  downloadArtifact(JSON.stringify(bundle, null, 2), bundleFileName(project.title));
  const messageCount = bundle.conversations.reduce((total, thread) => total + thread.messages.length, 0);
  return `Exported ${project.title} to ${bundleFileName(project.title)}: ${bundle.artifacts.length} artifact${bundle.artifacts.length === 1 ? "" : "s"} and ${messageCount} message${messageCount === 1 ? "" : "s"}.`;
}

/** The finished documents as one zip (#323); the notice says what went in. */
export function downloadDocuments(project: MenuProject): Promise<string> {
  return downloadProjectDocuments(project.id, { projectView: api.projectView, artifactContent: api.artifactContent, save: saveBlob });
}

export function ProjectMenu({
  project,
  trigger,
  align = "end",
  onChanged,
  onError,
  onNotice,
  onDeleted,
  onMenuOpenChange,
  onDialogOpenChange,
  onDismissPress,
  infoRequest = null,
}: {
  project: MenuProject;
  /** The element that opens the menu: the card's ellipsis, the workspace's title. */
  trigger: ReactElement;
  align?: "start" | "end";
  onChanged: () => void;
  onError: (cause: unknown) => void;
  onNotice: (message: string) => void;
  /** The project is gone; a host showing it should leave. */
  onDeleted?: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  onDialogOpenChange?: (open: boolean) => void;
  /** A press outside the menu is dismissing it (`card-face-guard.ts`). */
  onDismissPress?: () => void;
  infoRequest?: InfoRequest | null;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  // Rename opens the same dialog with the name field focused.
  const [focusName, setFocusName] = useState(false);
  // The project's own settings (#246), a dialog of its own beside the info.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Deleting takes two clicks, both in the menu: the second item only exists
  // after the first, so a slip cannot remove a project.
  const [confirming, setConfirming] = useState(false);
  // "Prune old versions…" shows its plan first and archives on the second
  // click, the way Delete asks twice (#297).
  const [pruning, setPruning] = useState<PrunePlan | null>(null);
  // "Repair this project…" asks twice too (#299): it rebuilds the run from
  // every recorded decision instead of the state the last run wrote.
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    onDialogOpenChange?.(infoOpen || settingsOpen);
    // The host wants the fact, not the callback's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoOpen, settingsOpen]);

  useEffect(() => {
    if (!infoRequest) return;
    setFocusName(infoRequest.withName);
    setInfoOpen(true);
  }, [infoRequest]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onChanged();
    } catch (cause) {
      onError(cause);
    }
  };

  const openInfo = (withName = false) => {
    setFocusName(withName);
    setInfoOpen(true);
  };

  return (
    <>
      <Menu
        onOpenChange={(open) => {
          onMenuOpenChange?.(open);
          if (!open) {
            setConfirming(false);
            setPruning(null);
            setRepairing(false);
          }
        }}
      >
        <MenuTrigger asChild>{trigger}</MenuTrigger>
        <MenuContent align={align} onPointerDownOutside={() => onDismissPress?.()}>
          <MenuItem onSelect={() => openInfo()}>Project info…</MenuItem>
          <MenuItem onSelect={() => openInfo(true)}>Rename</MenuItem>
          <MenuItem onSelect={() => setSettingsOpen(true)}>Settings…</MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() =>
              void act(async () => {
                onNotice(await downloadDocuments(project));
              })
            }
          >
            Download documents…
          </MenuItem>
          <MenuItem
            onSelect={() =>
              void act(async () => {
                onNotice(await exportProjectBundle(project));
              })
            }
          >
            Export…
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => void act(() => api.updateProject(project.id, { archived: !project.archivedAt }))}>
            {project.archivedAt ? "Unarchive" : "Archive"}
          </MenuItem>
          {pruning ? (
            <MenuItem
              disabled={pruning.archive.length === 0}
              onSelect={() =>
                void act(async () => {
                  const result = await api.pruneProjectVersions(project.id);
                  onNotice(
                    `Archived ${String(result.archived)} older version${result.archived === 1 ? "" : "s"} of ${project.title}; ${String(result.kept)} kept across ${String(result.lineages)} document${result.lineages === 1 ? "" : "s"}.`,
                  );
                })
              }
            >
              {pruning.archive.length === 0 ? prunePlanSummary(pruning) : `Yes, ${prunePlanSummary(pruning).replace(/^Archive/, "archive")}`}
            </MenuItem>
          ) : (
            <MenuItem
              onSelect={(event) => {
                event.preventDefault();
                void api.pruneProjectPlan(project.id).then(setPruning, onError);
              }}
            >
              Prune old versions…
            </MenuItem>
          )}
          {repairing ? (
            <MenuItem
              onSelect={() =>
                void act(async () => {
                  const ensured = await api.repairProjectWorkflow(project.id);
                  const replayed = ensured.replay?.replayed ?? 0;
                  onNotice(`Rebuilt ${project.title}'s workflow from ${String(replayed)} recorded decision${replayed === 1 ? "" : "s"}.`);
                })
              }
            >
              Yes, rebuild it from its decisions
            </MenuItem>
          ) : (
            <MenuItem
              onSelect={(event) => {
                event.preventDefault();
                setRepairing(true);
              }}
            >
              Repair this project…
            </MenuItem>
          )}
          <MenuSeparator />
          {confirming ? (
            <MenuItem
              className="menu-danger"
              onSelect={() =>
                void act(async () => {
                  await api.deleteProject(project.id);
                  onDeleted?.();
                })
              }
            >
              Yes, delete it
            </MenuItem>
          ) : (
            <MenuItem
              className="menu-danger"
              onSelect={(event) => {
                event.preventDefault();
                setConfirming(true);
              }}
            >
              Delete…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {infoOpen ? (
        // Portaled, but React-nested in the host: its events bubble to a
        // card face's handlers unless stopped here, the same as the menu's.
        <div
          className="card-dialog"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ProjectInfoDialog
            project={project}
            focusName={focusName}
            onClose={() => setInfoOpen(false)}
            onChanged={onChanged}
            onError={onError}
            onNotice={onNotice}
          />
        </div>
      ) : null}
      {settingsOpen ? (
        <div
          className="card-dialog"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ProjectSettingsDialog project={project} onClose={() => setSettingsOpen(false)} />
        </div>
      ) : null}
    </>
  );
}

const formatBytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${String(bytes)} B`);

export function ProjectInfoDialog({
  project,
  focusName = false,
  onClose,
  onChanged,
  onError,
  onNotice,
}: {
  project: MenuProject;
  /** Open with the name field focused (the menu's Rename). */
  focusName?: boolean;
  onClose: () => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
  onNotice: (message: string) => void;
}) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // INTEGRATE (CL-8756): lane-only wiring — what the usage line names as the
  // current model. Behavioral-only; main has no equivalent.
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
  const [title, setTitle] = useState(project.title);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .projectInfo(project.id)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    void api.activeModel().then((model) => {
      if (!cancelled) setActiveModel(model);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onChanged();
      return true;
    } catch (cause) {
      onError(cause);
      return false;
    }
  };

  // Edits are explicit: nothing is written until Save, which then closes
  // the dialog. Save is offered only once there is a change to keep.
  const nextTitle = title.trim();
  const dirty = nextTitle.length > 0 && nextTitle !== project.title;
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const ok = await act(() => api.updateProject(project.id, { title: nextTitle }));
    setSaving(false);
    if (ok) onClose();
  };

  // INTEGRATE (CL-8756): api.exportProject is gone on this lane — the bundle
  // is assembled in the browser and saved as a download, reported in main's
  // diction through main's notice line; failures ride main's error Banner.
  const exportProject = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      onNotice(await exportProjectBundle(project));
      onChanged();
    } catch (cause) {
      onError(cause);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="project-info">
        <DialogHeader>
          <DialogTitle>{project.title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {error ? <Banner tone="error" title={error} /> : null}
          <div className="field">
            <label htmlFor={`project-name-${project.id}`}>Name</label>
            <Dictated value={title} onValueChange={setTitle} align="center">
              <Input
                id={`project-name-${project.id}`}
                autoFocus={focusName}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save();
                  if (event.key === "Escape") setTitle(project.title);
                }}
                aria-label="Project name"
              />
            </Dictated>
          </div>
          {!info && !error ? <p className="inline-note">Loading…</p> : null}
          {info ? (
            <dl className="version-list project-info-facts">
              <div>
                <dt>Created</dt>
                <dd>{new Date(info.project.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Last activity</dt>
                <dd>{new Date(info.lastActivityAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Where it stands</dt>
                <dd>
                  {info.stage ? `${stageName(info.stage)} · ${info.stage} of 9` : "No run"}
                  {info.project.archivedAt ? " · archived" : ""}
                </dd>
              </div>
              <div>
                <dt>Artifacts</dt>
                <dd>
                  {info.artifacts.versions} version{info.artifacts.versions === 1 ? "" : "s"} across {info.artifacts.live} live artifact
                  {info.artifacts.live === 1 ? "" : "s"}, {formatBytes(info.artifacts.bytes)} stored
                </dd>
              </div>
              <div>
                <dt>Runs</dt>
                <dd>
                  {info.runs.total} run{info.runs.total === 1 ? "" : "s"}, {info.runs.builds} build attempt{info.runs.builds === 1 ? "" : "s"}
                </dd>
              </div>
              <div>
                <dt>Usage</dt>
                <dd>
                  {formatUsage(info.usage, activeModel ? `${activeModel.providerLabel} · ${activeModel.canonicalName}` : null)}
                  <br />
                  <span className="inline-note">
                    Inference cost is tracked for the workspace as a whole, above the project list; there is no per-project breakdown yet.
                  </span>
                </dd>
              </div>
              <div>
                <dt>Decisions</dt>
                <dd>
                  {info.decisions.approved} approved, {info.decisions.sentBack} sent back, {info.decisions.refused} refused
                </dd>
              </div>
            </dl>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={exporting} onClick={() => void exportProject()}>
            {exporting ? "Exporting…" : "Export…"}
          </Button>
          <Button
            onClick={() =>
              void act(() => api.updateProject(project.id, { archived: !project.archivedAt })).then((ok) => {
                if (ok) onClose();
              })
            }
          >
            {project.archivedAt ? "Unarchive" : "Archive"}
          </Button>
          {/* Deleting is the menu's two-step affair, not part of editing a
              project's info. */}
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
