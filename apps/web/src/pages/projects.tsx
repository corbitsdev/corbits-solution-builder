/**
 * Projects: the home list. A composer to start something, then the work as
 * cards — the mockup's layout, live data.
 */
// INTEGRATE (CL-8756): origin/main's SortableTable line is dropped here —
// this lane's client no longer exports SpendRow/SpendTotals (spend now lives
// in project-usage.ts), so the per-project spend table it backed is adapted
// below. Import order otherwise verbatim from main.
import {
  ChatInput,
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
import { Ellipsis, Plus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ActiveModel, type ImportOutcome, type ProjectInfo, type ProjectSummary } from "../client.js";
import { faceOpensProject } from "./card-face-guard.ts";
import { Banner, Button, downloadArtifact, stageName } from "../components.jsx";
// INTEGRATE (CL-8756): api.exportProject is gone on this lane — export is
// assembled in the browser (assembleBundle) and saved via downloadArtifact;
// stage/turn/done come from project-list.ts helpers and spend copy from
// project-usage.ts. Behavioral-only wiring; main's order and copy preserved.
import { assembleBundle, bundleFileName } from "../project-export.js";
import { readImportPayload } from "../project-import.js";
import { displayDone, displayStage, displayTurn } from "../project-list.js";
import { formatUsage } from "../project-usage.js";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { Dictated } from "../dictation.jsx";
import "./home-layout.css";
import {
  HOME_COMPOSER_PLACEHOLDER,
  HOME_EMPTY_DESCRIPTION,
  HOME_EMPTY_TITLE,
  HOME_NEEDS_DECISION,
  canStartProject,
  cardDescription,
  cardFootStage,
  stageTrackSegClass,
} from "./home-view.js";

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Card foot's right side, non-archived case: an absolute date, never a fake relative time. */
function startedLabel(createdAt: string): string {
  return `Started ${new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** What the import did, and, for a bundle from `main`, where the project landed. */
export function importNotice(fileName: string, brought: ImportOutcome): string {
  const written =
    brought.versions === undefined
      ? `${plural(brought.artifacts, "artifact")} and ${plural(brought.conversations, "conversation")}`
      : `${plural(brought.artifacts, "artifact")} (${plural(brought.versions, "version")}) and ${plural(brought.conversations, "conversation")}`;
  const parts = [`Imported ${fileName}: ${written}.`];
  const landing = brought.landing;
  if (landing) {
    if (landing.stopped) {
      parts.push(`The project's history could not be fully replayed${landing.landed === null ? "" : `; it is at stage ${String(landing.landed)}`}: ${landing.stopped}.`);
    } else if (landing.landed !== null) {
      parts.push(`Its history was replayed; it is at stage ${String(landing.landed)}.`);
    }
    parts.push(...landing.notes);
  }
  return parts.join(" ");
}

export function Projects({
  projects,
  onOpen,
  onChanged,
}: {
  projects: ProjectSummary[];
  onOpen: (projectId: string) => void;
  onChanged: () => void;
}) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the person hands over with the problem. Held here until the project
  // exists, then attached before it opens, so the first draft reads it.
  const [material, setMaterial] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const addMaterial = (files: FileList | File[]) => {
    const next = [...files].filter((file) => !material.some((held) => held.name === file.name && held.size === file.size));
    if (next.length > 0) setMaterial([...material, ...next]);
  };
  // Where an export landed, or what an import brought in: said once, here.
  const [notice, setNotice] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  /** Reads the chosen export and brings it in as a new project. */
  const importFile = async (file: File) => {
    setNotice("Importing…");
    setBusy(true);
    setError(null);
    try {
      const bundle: unknown = await readImportPayload(file);
      // INTEGRATE (CL-8756): this lane's importProject validates the bundle
      // itself and reports artifacts/conversations, not nodes/commands — main's
      // diction kept, fields mapped to what the client returns.
      const brought = await api.importProject(bundle);
      setNotice(importNotice(file.name, brought));
      onChanged();
      onOpen(brought.projectId);
    } catch (cause) {
      setError(
        cause instanceof ApiFailure
          ? cause.detail.message
          : cause instanceof SyntaxError
            ? `${file.name} is not a JSON file.`
            : String(cause),
      );
    } finally {
      setBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  // Whatever waits on the person first, then the furthest along. Archived ones
  // fold away.
  const live = projects.filter((project) => !project.archivedAt);
  const archived = projects.filter((project) => project.archivedAt);
  // INTEGRATE (CL-8756): main's turn === "question"/"approve" arms are dropped
  // here — this lane's summary turn is only "writing"|"idle" (question and
  // approval waits fold into needsDecision) — so needsDecision alone is the
  // person's-move signal. The furthest-along tiebreak below is verbatim main.
  const yourMove = (project: ProjectSummary) => project.needsDecision;
  const ordered = [...live].sort((left, right) => {
    if (yourMove(left) !== yourMove(right)) return yourMove(left) ? -1 : 1;
    return (right.stage ?? 0) - (left.stage ?? 0);
  });

  const start = async () => {
    if (!canStartProject(problem) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({
        problemStatement: problem.trim(),
        policy: DEFAULT_POLICY,
      });
      // Attached before the project opens: the first draft starts on open
      // and has to find the material already there.
      if (material.length > 0) await api.attachMaterial(created.projectId, material);
      setProblem("");
      setMaterial([]);
      onChanged();
      onOpen(created.projectId);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const failed = (cause: unknown) =>
    setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));

  return (
    <div className="home-page">
      <section
        className={dragging ? "new-project is-dragging" : "new-project"}
        aria-label="New project"
        onDragOver={(event) => {
          if ([...event.dataTransfer.types].includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (![...event.dataTransfer.types].includes("Files")) return;
          event.preventDefault();
          setDragging(false);
          addMaterial(event.dataTransfer.files);
        }}
      >
        {error ? <Banner tone="error" title={error} /> : null}
        {notice ? <p className="inline-note">{notice}</p> : null}
        <p id="home-composer-hint" className="visually-hidden">
          At least ten characters to start a project.
        </p>
        <Dictated value={problem} onValueChange={setProblem} disabled={busy}>
          {(mic) => (
          <ChatInput
            className="composer-box"
            value={problem}
            onValueChange={setProblem}
            onSend={() => void start()}
            working={busy}
            disabled={busy}
            placeholder={HOME_COMPOSER_PLACEHOLDER}
            onAttach={addMaterial}
            attachIcon={<Plus className="size-4" aria-hidden="true" />}
            sendIcon={<Send className="size-4" aria-hidden="true" />}
            leadingTools={mic}
            attachments={material.map((file) => ({ id: `${file.name}:${file.size}`, name: file.name }))}
            onRemoveAttachment={(entry) =>
              setMaterial(material.filter((held) => `${held.name}:${held.size}` !== entry.id))
            }
          />
          )}
        </Dictated>
      </section>

      <section className="project-grid-section" aria-labelledby="projects-title">
        <div className="section-label">
          <h2 id="projects-title">Projects</h2>
          <label className="import-link" title="A project this app exported — JSON or zip">
            Import a project
            <input
              ref={importInput}
              type="file"
              accept=".json,.zip,application/json,application/zip"
              hidden
              disabled={busy}
              aria-label="Choose a project this app exported (JSON or zip)"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
              }}
            />
          </label>
        </div>
        {live.length === 0 ? (
          <div className="project-grid">
            <div className="card is-empty">
              <h3>{HOME_EMPTY_TITLE}</h3>
              <p className="card-desc">{HOME_EMPTY_DESCRIPTION}</p>
            </div>
          </div>
        ) : (
          <div className="project-grid">
            {ordered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => onOpen(project.id)}
                onChanged={onChanged}
                onError={failed}
                onNotice={setNotice}
              />
            ))}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <details className="project-archive">
          <summary>
            {archived.length} archived
          </summary>
          <div className="project-grid">
            {archived.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => onOpen(project.id)}
                onChanged={onChanged}
                onError={failed}
                onNotice={setNotice}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Hold this long on a card to open info; the options menu on the face reaches it too. */
const LONG_PRESS_MS = 500;

/**
 * Exports one project the way this lane can: the bundle is assembled in the
 * browser (`assembleBundle`) and saved as a download. Returns the notice
 * line; shared by the card's options menu and the Project info dialog.
 */
async function exportProjectBundle(project: ProjectSummary): Promise<string> {
  const bundle = await assembleBundle(project.id, {
    projectView: api.projectView,
    artifactContent: api.artifactContent,
    stageAgentStatus: api.stageAgentStatus,
    readStageThread: api.readStageThread,
  });
  downloadArtifact(JSON.stringify(bundle, null, 2), bundleFileName(project.title));
  const messageCount = bundle.conversations.reduce((total, thread) => total + thread.messages.length, 0);
  return `Exported ${project.title} to ${bundleFileName(project.title)}: ${bundle.artifacts.length} artifact${bundle.artifacts.length === 1 ? "" : "s"} and ${messageCount} message${messageCount === 1 ? "" : "s"}.`;
}

function ProjectCard({
  project,
  onOpen,
  onChanged,
  onError,
  onNotice,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
  onNotice: (message: string) => void;
}) {
  // INTEGRATE (CL-8756): the list no longer carries a stage — the project
  // workflow is the only authority, so each card resolves its own stage
  // read-only (displayStage) plus done (displayDone) and whose turn it is off
  // the stage mail thread (displayTurn). `null` while unresolved or when the
  // workflow could not be read at all; `stageFailed` tells those apart so the
  // card offers a Retry rather than showing a stage number.
  const [stage, setStage] = useState<number | null>(null);
  const [stageFailed, setStageFailed] = useState(false);
  const [stageAttempt, setStageAttempt] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setStage(null);
    setStageFailed(false);
    setDone(false);
    let cancelled = false;
    void displayStage(project.id, api.projectWorkflowView).then((resolved) => {
      if (cancelled) return;
      if (resolved === null) {
        setStageFailed(true);
        return;
      }
      setStage(resolved);
      setDone(displayDone(project.id));
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, stageAttempt]);
  // INTEGRATE (CL-8756): main's turn arms are dropped here too — the summary
  // turn is only "writing"|"idle" — so the card reads whose turn it is off the
  // current stage's mail thread instead. Never for an archived project or
  // before the stage resolves.
  const [turn, setTurn] = useState<string | null>(null);
  useEffect(() => {
    if (project.archivedAt || stage === null) {
      setTurn(null);
      return;
    }
    let cancelled = false;
    void displayTurn(project.id, stage, project.needsDecision, {
      workspaceTenantId: api.workspaceTenantId,
      stageAgentStatus: api.stageAgentStatus,
      readStageThread: api.readStageThread,
    }).then((resolved) => {
      if (!cancelled) setTurn(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.archivedAt, project.needsDecision, stage]);
  const waiting = project.needsDecision;
  const [infoOpen, setInfoOpen] = useState(false);
  // Rename opens the same dialog with the name field focused.
  const [focusName, setFocusName] = useState(false);
  // Deleting takes two clicks, both in the menu: the second item only exists
  // after the first, so a slip cannot remove a project.
  const [confirming, setConfirming] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The face is inert while the options menu or the info dialog is up, and
  // for a moment after either closes (`card-face-guard.ts`): the click that
  // dismisses a menu lands on the face the instant the menu lets go.
  const [menuOpen, setMenuOpen] = useState(false);
  const closedAt = useRef<number | null>(null);
  // Set by the press that dismisses the menu, consumed by the click it
  // produces; a fresh press on the face clears it first.
  const dismissing = useRef(false);
  const faceOpens = () =>
    faceOpensProject({ menuOpen, dialogOpen: infoOpen, dismissingClick: dismissing.current, closedAt: closedAt.current, now: Date.now() });

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onChanged();
    } catch (cause) {
      onError(cause);
    }
  };

  useEffect(
    () => () => {
      if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    },
    [],
  );

  const clearPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const openInfo = (withName = false) => {
    setFocusName(withName);
    setInfoOpen(true);
  };
  const closeInfo = () => {
    closedAt.current = Date.now();
    setInfoOpen(false);
  };

  return (
    <article
      className={waiting ? "card needs" : "card"}
      tabIndex={0}
      aria-label={project.title}
      onClick={() => {
        const opens = faceOpens();
        dismissing.current = false;
        if (opens) onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (faceOpens()) openInfo();
      }}
      onPointerDown={(event) => {
        // A fresh press: whatever the last one dismissed is done with. Runs
        // before the menu's own outside-press handler on the document, so a
        // press that dismisses the menu clears this first and then marks it.
        dismissing.current = false;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        clearPress();
        if (!faceOpens()) return;
        pressTimer.current = setTimeout(() => openInfo(), LONG_PRESS_MS);
      }}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (faceOpens()) onOpen();
        }
      }}
    >
      <div className="card-top">
        <h3>{project.title}</h3>
        <div className="card-top-end">
          {waiting ? <span className="badge-decision">{HOME_NEEDS_DECISION}</span> : null}
          {/* The menu sits inside the card, whose face opens the project on
              click and long-press; nothing from the menu, its trigger or its
              (portaled, but React-nested) items may reach those handlers. */}
          <div
            className="card-menu"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Menu
              onOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) {
                  setConfirming(false);
                  closedAt.current = Date.now();
                }
              }}
            >
              <MenuTrigger asChild>
                <button type="button" className="project-card-menu" aria-label={`Options for ${project.title}`}>
                  <Ellipsis aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent align="end" onPointerDownOutside={() => (dismissing.current = true)}>
                <MenuItem onSelect={() => openInfo()}>Project info…</MenuItem>
                <MenuItem onSelect={() => openInfo(true)}>Rename</MenuItem>
                <MenuItem
                  onSelect={() =>
                    void act(async () => {
                      onNotice(await exportProjectBundle(project));
                    })
                  }
                >
                  Export…
                </MenuItem>
                <MenuItem onSelect={() => void act(() => api.updateProject(project.id, { archived: !project.archivedAt }))}>
                  {project.archivedAt ? "Unarchive" : "Archive"}
                </MenuItem>
                <MenuSeparator />
                {confirming ? (
                  <MenuItem className="menu-danger" onSelect={() => void act(() => api.deleteProject(project.id))}>
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
          </div>
        </div>
        {infoOpen ? (
          // Portaled, but React-nested in the card: its events bubble to the
          // face's handlers unless stopped here, the same as the menu's.
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
              onClose={closeInfo}
              onChanged={onChanged}
              onError={onError}
              onNotice={onNotice}
            />
          </div>
        ) : null}
      </div>

      <p className="card-desc">{cardDescription(project)}</p>

      <StageTrack stage={stage} done={done} />

      <div className="card-foot">
        <span>
          {cardFootStage(stage, done, stageFailed)}
          {stageFailed ? (
            <>
              {" "}
              <button
                type="button"
                className="link-button"
                onClick={(event) => {
                  event.stopPropagation();
                  setStageAttempt((attempt) => attempt + 1);
                }}
              >
                Retry
              </button>
            </>
          ) : null}
        </span>
        <span>{turn ?? (project.archivedAt ? "Archived" : startedLabel(project.createdAt))}</span>
      </div>
    </article>
  );
}

/** The same nine-segment language the topbar stepper speaks, one per card. */
function StageTrack({ stage, done }: { stage: number | null; done: boolean }) {
  return (
    <div className="card-track" role="img" aria-label={stage ? `Stage ${stage} of 9` : "Stage unknown"}>
      {Array.from({ length: 9 }, (_, index) => {
        const at = index + 1;
        return <span key={at} className={stageTrackSegClass(at, stage, done)} />;
      })}
    </div>
  );
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One project, described: when it began, where it stands, and what it holds. */
// INTEGRATE (CL-8756): main's info shape is gone on this lane — stage is a
// bare number, approvals and the per-project spend table (SortableTable,
// SpendRow) no longer exist — so the dialog keeps main's shell and row order
// while usage rides formatUsage and decisions get their own row. Every
// adapted hunk below carries its own note.
function ProjectInfoDialog({
  project,
  focusName = false,
  onClose,
  onChanged,
  onError,
  onNotice,
}: {
  project: ProjectSummary;
  /** Open with the name field focused (the card menu's Rename). */
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
            <>
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
                    {/* INTEGRATE (CL-8756): info.stage is a bare number now —
                        no run state to name — main's row and archived suffix
                        kept. */}
                    {info.stage ? `Stage ${info.stage} of 9 · ${stageName(info.stage)}` : "No run"}
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
                    {/* INTEGRATE (CL-8756): info.approvals is gone — decisions
                        get their own row below — main's run/build copy kept. */}
                    {info.runs.total} run{info.runs.total === 1 ? "" : "s"}, {info.runs.builds} build attempt{info.runs.builds === 1 ? "" : "s"}
                  </dd>
                </div>
                <div>
                  <dt>Usage</dt>
                  <dd>
                    {/* INTEGRATE (CL-8756): lane-only row — per-project spend
                        has no table anymore, so usage is one formatUsage line
                        in main's inline-note diction. */}
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
                    {/* INTEGRATE (CL-8756): main folded one approvals count
                        into Runs — the lane folds the decision log instead. */}
                    {info.decisions.approved} approved, {info.decisions.sentBack} sent back, {info.decisions.refused} refused
                  </dd>
                </div>
              </dl>
              {/* INTEGRATE (CL-8756): main's Inference spend section is dropped
                  here — info.spend and its SortableTable no longer exist — the
                  Usage row above is what this lane can say per project. */}
            </>
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
          {/* Deleting is the card menu's two-step affair, not part of editing
              a project's info. */}
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
