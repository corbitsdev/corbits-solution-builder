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
import { api, ApiFailure, type ProjectInfo, type ProjectSummary } from "../client.js";
import { Button, Banner, StageRing, StateLabel, stageName } from "../components.jsx";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { Dictated } from "../dictation.jsx";
import { foldStageThread, nextOpenQuestion } from "../stage-thread.ts";
import type { Stage } from "@solutions-builder/app/ledger";

/**
 * The open-question badge, folded client-side from `/hub` events: the host
 * only says whether there is a draft to approve (`projects.ts`'s `turn`), so
 * a project idle on that count is checked here, one fold per idle row.
 */
function useOpenQuestions(projects: ProjectSummary[]): Map<string, { ordinal: number; remaining: number }> {
  const [open, setOpen] = useState(new Map<string, { ordinal: number; remaining: number }>());
  const pending = projects.filter((project) => !project.archivedAt && project.turn === "idle" && project.stage);
  const key = pending.map((project) => `${project.id}:${project.anchorRunId ?? ""}`).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      pending.map(async (project) => {
        const turns = await foldStageThread({
          tenantId: project.tenantId,
          anchorRunId: project.anchorRunId,
          stage: project.stage as unknown as Stage,
          nodes: [],
          opening: null,
          carried: [],
        }).catch(() => []);
        const found = nextOpenQuestion(turns);
        return [project.id, found ? { ordinal: found.ordinal, remaining: found.remaining } : null] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setOpen(new Map(entries.filter((entry): entry is [string, { ordinal: number; remaining: number }] => entry[1] !== null)));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return open;
}

/** A project row with its host-computed `turn`/`question` overridden by the client fold, when one is open. */
function withOpenQuestion(project: ProjectSummary, open: Map<string, { ordinal: number; remaining: number }>): ProjectSummary {
  const question = open.get(project.id);
  return question ? { ...project, turn: "question", question } : project;
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
  const materialInput = useRef<HTMLInputElement>(null);
  const addMaterial = (files: FileList | File[]) => {
    const next = [...files].filter((file) => !material.some((held) => held.name === file.name && held.size === file.size));
    if (next.length > 0) setMaterial([...material, ...next]);
  };
  // Whatever waits on the person first, then the furthest along. Archived ones
  // fold away.
  const openQuestions = useOpenQuestions(projects);
  const live = projects.filter((project) => !project.archivedAt).map((project) => withOpenQuestion(project, openQuestions));
  const archived = projects.filter((project) => project.archivedAt);
  const yourMove = (project: ProjectSummary) =>
    project.needsDecision || project.turn === "question" || project.turn === "approve";
  const ordered = [...live].sort((left, right) => {
    if (yourMove(left) !== yourMove(right)) return yourMove(left) ? -1 : 1;
    return (right.stage ?? 0) - (left.stage ?? 0);
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
  const stage = project.stage ?? 0;
  const waiting =
    project.needsDecision || project.turn === "question" || project.turn === "approve";
  const [renaming, setRenaming] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  // Deleting takes two clicks, both in the menu: the second item only exists
  // after the first, so a slip cannot remove a project.
  const [confirming, setConfirming] = useState(false);
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
  ) : project.needsDecision ? (
    <StateLabel tone="warning">{project.waits[0]?.title ?? "Needs your decision"}</StateLabel>
  ) : project.state === "delivered" ? (
    <StateLabel tone="success">Delivered</StateLabel>
  ) : project.state === "backtracked" ? (
    <StateLabel tone="error">Routed back</StateLabel>
  ) : project.turn === "writing" ? (
    <StateLabel tone="loading">Writing the draft</StateLabel>
  ) : project.turn === "question" && project.question ? (
    <StateLabel tone="warning">
      Your turn · question {project.question.ordinal + 1} of{" "}
      {project.question.ordinal + 1 + project.question.remaining}
    </StateLabel>
  ) : project.turn === "approve" ? (
    <StateLabel tone="warning">Draft ready to approve</StateLabel>
  ) : project.stage ? (
    <StateLabel tone="info">Waiting to start</StateLabel>
  ) : (
    <StateLabel tone="info">Not started</StateLabel>
  );

  return (
    <article
      className={waiting ? "project-card stagger needs-decision" : "project-card stagger"}
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="project-card-stage">
        <StageRing stage={stage} />
        <span>
          Stage {stage || "—"} of 9 · {stageName(project.stage)}
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
                    {info.stage ? `Stage ${info.stage.stage} of 9 · ${stageName(info.stage.stage)} · ${info.stage.state.replace(/_/g, " ")}` : "No run"}
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
                    {info.runs.total} run{info.runs.total === 1 ? "" : "s"}, {info.runs.builds} build attempt{info.runs.builds === 1 ? "" : "s"}, {info.approvals} decision
                    {info.approvals === 1 ? "" : "s"} recorded
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
