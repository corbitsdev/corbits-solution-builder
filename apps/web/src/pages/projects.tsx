/**
 * Projects: the home list. A composer to start something, then the work as
 * cards — the mockup's layout, live data.
 */
import { ChatInput } from "@corbits/react-ui";
import { Ellipsis, Plus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { STAGES } from "@solutions-builder/app/ledger";
import { api, ApiFailure, type ImportOutcome, type ProjectSummary } from "../client.js";
import { faceOpensProject } from "./card-face-guard.ts";
import { Banner } from "../components.jsx";
import { readImportPayload } from "../project-import.js";
import { displayDone, displayStage, displayTurn } from "../project-list.js";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { ProjectMenu, type InfoRequest } from "./project-menu.jsx";
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
import { stageName } from "../stage-names.ts";

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
  // The summary turn is only "writing"|"idle" (question and approval waits
  // fold into needsDecision), so needsDecision alone is the person's-move signal.
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
  // The list carries no stage — the project workflow is the only authority,
  // so each card resolves its own stage
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
  // The summary turn is only "writing"|"idle", so the card reads whose turn it
  // is off the current stage's mail thread. Never for an archived project or
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
    <div className="card-track" role="img" aria-label={stage ? `Progress: ${stageName(stage)}` : "Progress unknown"}>
      {STAGES.map((at) => (
        <span key={at} className={stageTrackSegClass(at, stage, done)} />
      ))}
    </div>
  );
}
