/**
 * Projects: where a person starts something and where they pick up what is
 * already going.
 *
 * One question at the top, asked the way the rest of the app talks — a message
 * box, not a form. Under it the projects as cards, the ones waiting on a
 * decision first, because that is the whole point of surfacing them.
 */
import type React from "react";
import {
  ChatInput,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@corbits/react-ui";
import { ArrowRight, Ellipsis } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ActiveModel, type ProjectInfo, type ProjectSummary } from "../client.js";
import { Button, Banner, downloadArtifact, StageRing, StateLabel, stageName } from "../components.jsx";
import { assembleBundle, bundleFileName } from "../project-export.js";
import { displayDone, displayStage, displayTurn } from "../project-list.js";
import { formatUsage } from "../project-usage.js";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { Dictated } from "../dictation.jsx";

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
  const materialInput = useRef<HTMLInputElement>(null);
  const addMaterial = (files: FileList | File[]) => {
    const next = [...files].filter((file) => !material.some((held) => held.name === file.name && held.size === file.size));
    if (next.length > 0) setMaterial([...material, ...next]);
  };
  // Where an import landed: said once, here, next to the input it came from.
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  /** Reads the chosen export and brings it in as a new project — no host route, every write goes straight through the client. */
  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setImportNotice(null);
    try {
      const raw: unknown = JSON.parse(await file.text());
      const brought = await api.importProject(raw);
      setImportNotice(
        `Imported ${brought.artifacts} artifact${brought.artifacts === 1 ? "" : "s"} and ${brought.conversations} conversation${brought.conversations === 1 ? "" : "s"}.`,
      );
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

  // Whatever waits on the person first. Archived ones fold away. Stage is
  // read per card (CL-8687/CL-8721), not on the list itself, so it plays no
  // part in this ordering.
  const live = projects.filter((project) => !project.archivedAt);
  const archived = projects.filter((project) => project.archivedAt);
  const yourMove = (project: ProjectSummary) => project.needsDecision;
  const ordered = [...live].sort((left, right) => {
    if (yourMove(left) !== yourMove(right)) return yourMove(left) ? -1 : 1;
    return 0;
  });

  const start = async () => {
    if (problem.trim().length < 10 || busy) return;
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
    <div className="projects">
      <section
        className={dragging ? "start is-dragging" : "start"}
        aria-labelledby="start-title"
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
        <h2 id="start-title">What are we building?</h2>
        <p className="start-lead">
          Describe your problem in your own words. We will brainstorm with you to find the right
          solution. If you have any documents or other information you would like to give us, just
          drag it here.
        </p>
        {error ? <Banner tone="error" title={error} /> : null}
        <Dictated value={problem} onValueChange={setProblem} disabled={busy}>
          <ChatInput
            className="start-input"
            value={problem}
            onValueChange={setProblem}
            onSend={() => void start()}
            working={busy}
            disabled={busy}
            placeholder="The thing that keeps eating your afternoons…"
          />
        </Dictated>
        <p className="start-hint">
          {problem.trim().length > 0 && problem.trim().length < 10
            ? "A little more. A sentence is enough."
            : "Enter to start. Rough is fine."}
        </p>
        {/* The material, named, each removable, and a picker for anyone not
            dragging. What the specialists can read is said plainly. */}
        <div className="start-material">
          <input
            ref={materialInput}
            type="file"
            multiple
            hidden
            accept=".txt,.md,.csv,.json,.html,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.pdf,.png,.jpg,.jpeg,.gif,.webp"
            aria-label="Choose documents or images to give the specialists"
            onChange={(event) => {
              if (event.target.files) addMaterial(event.target.files);
              event.target.value = "";
            }}
          />
          {material.length > 0 ? (
            <ul className="material-list" aria-label="Attached files">
              {material.map((file) => (
                <li key={`${file.name}:${file.size}`} className="material-chip">
                  <span>{file.name}</span>
                  <span className="material-size">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                  <button
                    type="button"
                    className="material-remove"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setMaterial(material.filter((held) => held !== file))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="start-hint">
            <Button variant="link" disabled={busy} onClick={() => materialInput.current?.click()}>
              Add documents or images…
            </Button>
            {" "}Spreadsheets, PDFs, text, CSV, JSON, Markdown and HTML are read by the specialists.
            Word files and images are kept with the project and named to them.
          </p>
        </div>
        {/* A project exported from another copy of this app. The file is one
            of its own exports; the input is hidden because the picker is the
            whole interaction. */}
        <p className="start-import">
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Choose a project export to import"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          <Button variant="link" disabled={busy} onClick={() => importInput.current?.click()}>
            Import a project exported from another copy of this app…
          </Button>
        </p>
        {importNotice ? <p className="inline-note">{importNotice}</p> : null}
      </section>

      <section className="project-grid-section" aria-labelledby="projects-title">
        <h3 id="projects-title" className="project-grid-title">
          {live.length === 0
            ? "Nothing in progress"
            : `${live.length} project${live.length === 1 ? "" : "s"}`}
        </h3>
        {live.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Start with a problem you can describe but have not scoped."
          />
        ) : (
          <div className="project-grid">
            {ordered.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                index={index}
                onOpen={() => onOpen(project.id)}
                onChanged={onChanged}
                onError={failed}
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
            {archived.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                index={index}
                onOpen={() => onOpen(project.id)}
                onChanged={onChanged}
                onError={failed}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ProjectCard({
  project,
  index,
  onOpen,
  onChanged,
  onError,
}: {
  project: ProjectSummary;
  index: number;
  onOpen: () => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  // The project workflow's own stage (CL-8687/CL-8721) — read-only, never
  // triggers a deploy just to show a card. `null` while unresolved or when
  // the workflow could not be read at all; `stageFailed` distinguishes the
  // latter so the card can offer a Retry rather than showing a stage number.
  const [stage, setStage] = useState<number | null>(null);
  const [stageFailed, setStageFailed] = useState(false);
  const [stageAttempt, setStageAttempt] = useState(0);
  // Whether the project workflow's own `done` has landed (CL-8723): stage 9's
  // `approve` decision, not just having reached stage 9.
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
  // Whose turn it is, read off the current stage's mail thread alone
  // (CL-8725) -- never for an archived project or before the stage resolves.
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
  const [renaming, setRenaming] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  // Deleting takes two clicks, both in the menu: the second item only exists
  // after the first, so a slip cannot remove a project.
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) field.current?.select();
  }, [renaming]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onChanged();
    } catch (cause) {
      onError(cause);
    }
  };

  const exportProject = async () => {
    if (exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const bundle = await assembleBundle(project.id, {
        projectView: api.projectView,
        artifactContent: api.artifactContent,
        stageAgentStatus: api.stageAgentStatus,
        readStageThread: api.readStageThread,
      });
      downloadArtifact(JSON.stringify(bundle, null, 2), bundleFileName(project.title));
      const messageCount = bundle.conversations.reduce((total, thread) => total + thread.messages.length, 0);
      setExportNotice(
        `Exported ${bundle.artifacts.length} artifact${bundle.artifacts.length === 1 ? "" : "s"} and ${messageCount} message${messageCount === 1 ? "" : "s"}.`,
      );
    } catch (cause) {
      setExportNotice(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setExporting(false);
    }
  };

  const rename = () => {
    const next = title.trim();
    setRenaming(false);
    if (next.length === 0 || next === project.title) {
      setTitle(project.title);
      return;
    }
    void act(() => api.updateProject(project.id, { title: next }));
  };

  const status = project.archivedAt ? (
    <StateLabel tone="disabled">Archived</StateLabel>
  ) : stageFailed ? (
    <StateLabel tone="error">Status unavailable</StateLabel>
  ) : done ? (
    <StateLabel tone="success">Delivered</StateLabel>
  ) : project.needsDecision ? (
    <StateLabel tone="warning">{project.waits[0]?.title ?? "Needs your decision"}</StateLabel>
  ) : turn ? (
    <StateLabel tone={turn === "Specialist working" ? "loading" : "warning"}>{turn}</StateLabel>
  ) : stage ? (
    <StateLabel tone="info">In progress</StateLabel>
  ) : (
    <StateLabel tone="info">Not started</StateLabel>
  );

  return (
    <article
      className={waiting ? "project-card stagger needs-decision" : "project-card stagger"}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="project-card-stage">
        <StageRing stage={stage ?? 0} />
        {stageFailed ? (
          <span>
            Status unavailable{" "}
            <button type="button" className="link-button" onClick={() => setStageAttempt((attempt) => attempt + 1)}>
              Retry
            </button>
          </span>
        ) : (
          <span>{done ? "Delivered · project finished" : `Stage ${stage || "—"} of 9 · ${stageName(stage ?? 0)}`}</span>
        )}
        <span className="project-card-usage inline-note">
          {project.runs} stage run{project.runs === 1 ? "" : "s"} · not priced
        </span>
        <Menu onOpenChange={(open) => !open && setConfirming(false)}>
          <MenuTrigger asChild>
            <button type="button" className="project-card-menu" aria-label={`Options for ${project.title}`}>
              <Ellipsis aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setInfoOpen(true)}>Project info…</MenuItem>
            <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem
              onSelect={() =>
                void act(() => api.updateProject(project.id, { archived: !project.archivedAt }))
              }
            >
              {project.archivedAt ? "Unarchive" : "Archive"}
            </MenuItem>
            <MenuItem disabled={exporting} onSelect={() => void exportProject()}>
              {exporting ? "Exporting…" : "Export…"}
            </MenuItem>
            <MenuSeparator />
            {confirming ? (
              <MenuItem
                className="menu-danger"
                onSelect={() => void act(() => api.deleteProject(project.id))}
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
        {infoOpen ? <ProjectInfoDialog project={project} onClose={() => setInfoOpen(false)} /> : null}
      </div>

      {renaming ? (
        <Dictated value={title} onValueChange={setTitle} align="center">
          <Input
            ref={field}
            className="project-card-rename"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === "Enter") rename();
              if (event.key === "Escape") {
                setTitle(project.title);
                setRenaming(false);
              }
            }}
            aria-label="Project name"
          />
        </Dictated>
      ) : (
        <button type="button" className="project-card-open-area" onClick={onOpen}>
          <h4>{project.title}</h4>
        </button>
      )}

      {exportNotice ? <p className="inline-note">{exportNotice}</p> : null}

      <div className="project-card-foot">
        {status}
        <button type="button" className="project-card-open" onClick={onOpen}>
          Open <ArrowRight aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** One project, described: when it began, where it stands, and what it holds. */
function ProjectInfoDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<ActiveModel | null>(null);
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
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="project-info">
        <DialogHeader>
          <DialogTitle>{project.title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {error ? <Banner tone="error" title={error} /> : null}
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
                    {info.stage ? `Stage ${info.stage} of 9 · ${stageName(info.stage)}` : "Not started"}
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
                    {info.runs.total} specialist run{info.runs.total === 1 ? "" : "s"}, {info.runs.builds} build{info.runs.builds === 1 ? "" : "s"}
                  </dd>
                </div>
                <div>
                  <dt>Usage</dt>
                  <dd>{formatUsage(info.usage, activeModel ? `${activeModel.providerLabel} · ${activeModel.canonicalName}` : null)}</dd>
                </div>
                <div>
                  <dt>Decisions</dt>
                  <dd>
                    {info.decisions.approved} approved, {info.decisions.sentBack} sent back, {info.decisions.refused} refused
                  </dd>
                </div>
              </dl>
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
