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
import { api, ApiFailure, type ProjectSummary } from "../client.js";
import { Banner, StageRing, StateLabel, stageName } from "../components.jsx";
import { DEFAULT_POLICY } from "./onboarding.jsx";
import { DictationButton } from "../dictation.jsx";

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

  // Whatever waits on the person first, then the furthest along. Archived ones
  // fold away.
  const live = projects.filter((project) => !project.archivedAt);
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
      setProblem("");
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
      <section className="start" aria-labelledby="start-title">
        <h2 id="start-title">What are we building?</h2>
        <p className="start-lead">
          Describe the problem however it comes out. Scoping it is the first stage, and the
          specialist will ask about what it does not know.
        </p>
        {error ? <Banner tone="error" title={error} /> : null}
        <ChatInput
          className="start-input"
          value={problem}
          onValueChange={setProblem}
          onSend={() => void start()}
          working={busy}
          disabled={busy}
          placeholder="The thing that keeps eating your afternoons…"
        />
        <p className="start-hint">
          <DictationButton value={problem} onValueChange={setProblem} disabled={busy} />
          {problem.trim().length > 0 && problem.trim().length < 10
            ? "A little more. A sentence is enough."
            : "Enter to start. Rough is fine."}
        </p>
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
      </div>

      {renaming ? (
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
