/**
 * Projects: the home list. A composer to start something, then the work as
 * cards — the mockup's layout, live data.
 */
// INTEGRATE (CL-8756): origin/main's SortableTable line is dropped here —
// this lane's client no longer exports SpendRow/SpendTotals (spend now lives
// in project-usage.ts), so the per-project spend table it backed is adapted
// below. Import order otherwise verbatim from main.
import { toast } from "sonner";
import { ChatInput } from "@corbits/react-ui";
import { Ellipsis, Plus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiFailure, type ImportOutcome, type ProjectSummary } from "../client.js";
import { faceOpensProject } from "./card-face-guard.ts";
import { Banner, Button, stageName } from "../components.jsx";
// INTEGRATE (CL-8756): api.exportProject is gone on this lane — export is
// assembled in the browser (assembleBundle) and saved via downloadArtifact;
// stage/turn/done come from project-list.ts helpers and spend copy from
// project-usage.ts. Behavioral-only wiring; main's order and copy preserved.
import { readImportPayload } from "../project-import.js";
import { displayTurn } from "../project-list.js";
import { keys } from "../queries/keys.ts";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { plural, ProjectMenu, type InfoRequest } from "./project-menu.jsx";
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
      parts.push(`The project's history could not be fully replayed${landing.landed === null ? "" : `; it is at ${stageName(landing.landed)}`}: ${landing.stopped}.`);
    } else if (landing.landed !== null) {
      parts.push(`Its history was replayed; it is at ${stageName(landing.landed)}.`);
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
  const importInput = useRef<HTMLInputElement>(null);

  /** Reads the chosen export and brings it in as a new project. */
  const importFile = async (file: File) => {
    const importing = toast.loading(`Importing ${file.name}…`);
    setBusy(true);
    try {
      const bundle: unknown = await readImportPayload(file);
      // INTEGRATE (CL-8756): this lane's importProject validates the bundle
      // itself and reports artifacts/conversations, not nodes/commands — main's
      // diction kept, fields mapped to what the client returns.
      const brought = await api.importProject(bundle);
      toast.success(importNotice(file.name, brought), { id: importing });
      onChanged();
      onOpen(brought.projectId);
    } catch (cause) {
      toast.error(
        cause instanceof ApiFailure
          ? cause.detail.message
          : cause instanceof SyntaxError
            ? `${file.name} is not a JSON file.`
            : String(cause),
        { id: importing },
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
                onNotice={(message) => toast.success(message)}
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
                onNotice={(message) => toast.success(message)}
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
  // The list carries no stage: the project workflow is the only authority,
  // so each card reads it. No workflow yet, or a run that has not written its
  // first state (stage 0), has not started; a read that failed offers Retry.
  const workflow = useQuery({
    queryKey: keys.workflowView.card(project.id),
    queryFn: () => api.projectWorkflowView(project.id),
    retry: false,
  });
  const stage = workflow.data && workflow.data.stage >= 1 ? workflow.data.stage : null;
  const done = workflow.data?.done ?? false;
  const stageFailed = workflow.isError;
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
  // The menu, its two-step items and the dialogs it opens are `ProjectMenu`'s
  // (#323); the card only needs to know when one of them is up.
  const [dialogOpen, setDialogOpen] = useState(false);
  // The context menu and long-press open the info dialog from outside the menu.
  const [infoRequest, setInfoRequest] = useState<InfoRequest | null>(null);
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
    faceOpensProject({ menuOpen, dialogOpen, dismissingClick: dismissing.current, closedAt: closedAt.current, now: Date.now() });

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

  const openInfo = (withName = false) => setInfoRequest({ withName, at: Date.now() });

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
            <ProjectMenu
              project={project}
              trigger={
                <button type="button" className="project-card-menu" aria-label={`Options for ${project.title}`}>
                  <Ellipsis aria-hidden="true" />
                </button>
              }
              onChanged={onChanged}
              onError={onError}
              onNotice={onNotice}
              onMenuOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) closedAt.current = Date.now();
              }}
              onDialogOpenChange={(open) => {
                setDialogOpen(open);
                if (!open) closedAt.current = Date.now();
              }}
              onDismissPress={() => {
                dismissing.current = true;
              }}
              infoRequest={infoRequest}
            />
          </div>
        </div>
      </div>

      <p className="card-desc">{cardDescription(project)}</p>

      <StageTrack stage={stage} done={done} />

      <div className="card-foot">
        <span>
          {workflow.isPending ? null : cardFootStage(stage, done, stageFailed)}
          {stageFailed ? (
            <>
              {" "}
              <button
                type="button"
                className="link-button"
                onClick={(event) => {
                  event.stopPropagation();
                  void workflow.refetch();
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
    <div className="card-track" role="img" aria-label={stage ? `${stageName(stage)} · ${stage} of 9` : "Stage unknown"}>
      {Array.from({ length: 9 }, (_, index) => {
        const at = index + 1;
        return <span key={at} className={stageTrackSegClass(at, stage, done)} />;
      })}
    </div>
  );
}


/** One project, described: when it began, where it stands, and what it holds. */
// INTEGRATE (CL-8756): main's info shape is gone on this lane — stage is a
// bare number, approvals and the per-project spend table (SortableTable,
// SpendRow) no longer exist — so the dialog keeps main's shell and row order
// while usage rides formatUsage and decisions get their own row. Every
// adapted hunk below carries its own note.
