/**
 * Projects: where a person starts something and where they pick up what is
 * already going.
 *
 * One question at the top, asked the way the rest of the app talks — a message
 * box, not a form. Under it the projects as cards, the ones waiting on a
 * decision first, because that is the whole point of surfacing them.
 */
// INTEGRATE (CL-8756): origin/main's SortableTable line is dropped here —
// this lane's client no longer exports SpendRow/SpendTotals (spend now lives
// in project-usage.ts), so the per-project spend table it backed is adapted
// below. Import order otherwise verbatim from main.
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
import { Button, Banner, downloadArtifact, StateLabel, stageName } from "../components.jsx";
// INTEGRATE (CL-8756): api.exportProject is gone on this lane — export is
// assembled in the browser (assembleBundle) and saved via downloadArtifact;
// stage/turn/done come from project-list.ts helpers and spend copy from
// project-usage.ts. Behavioral-only wiring; main's order/copy preserved.
import { assembleBundle, bundleFileName } from "../project-export.js";
import { displayDone, displayStage, displayTurn } from "../project-list.js";
import { formatSpendHeadline, formatUsage, type TokenCounts, type WorkspaceSpend } from "../project-usage.js";
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
  // Where an export landed, or what an import brought in: said once, here.
  const [notice, setNotice] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  /** Reads the chosen export and brings it in as a new project. */
  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const bundle: unknown = JSON.parse(await file.text());
      // INTEGRATE (CL-8756): this lane's importProject validates the bundle
      // itself and reports artifacts/conversations, not nodes/commands — main's
      // diction kept, fields mapped to what the client returns.
      const brought = await api.importProject(bundle);
      setNotice(`Imported ${file.name}: ${brought.artifacts} artifact${brought.artifacts === 1 ? "" : "s"} and ${brought.conversations} conversation${brought.conversations === 1 ? "" : "s"}.`);
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
        {/* INTEGRATE (CL-8756): main's okay Banner becomes an inline-note line —
            same diction, said once next to the input it came from. */}
        {notice ? <p className="inline-note">{notice}</p> : null}
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

      <SpendBox key={projects.length} />

      <section className="project-grid-section" aria-labelledby="projects-title">
        <div className="project-grid-head">
          <h3 id="projects-title" className="project-grid-title">
            {live.length === 0
              ? "Nothing in progress"
              : `${live.length} project${live.length === 1 ? "" : "s"}`}
          </h3>
          {/* A project from another instance of this app. The file is one of
              its own exports; the input is hidden because the file picker is
              the whole interaction and a bare input reads as a form. */}
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
          <button
            type="button"
            className="import-link"
            disabled={busy}
            onClick={() => importInput.current?.click()}
          >
            Import bundle
          </button>
        </div>
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
            {archived.map((project, index) => (
              <ProjectCard
                key={project.id}
                project={project}
                index={index}
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

function ProjectCard({
  project,
  index,
  onOpen,
  onChanged,
  onError,
  onNotice,
}: {
  project: ProjectSummary;
  index: number;
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

  // INTEGRATE (CL-8756): api.exportProject is gone on this lane — the bundle
  // is assembled in the browser and saved as a download, reported in main's
  // diction through main's notice line; failures ride main's error Banner.
  const [exporting, setExporting] = useState(false);
  const exportProject = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const bundle = await assembleBundle(project.id, {
        projectView: api.projectView,
        artifactContent: api.artifactContent,
        stageAgentStatus: api.stageAgentStatus,
        readStageThread: api.readStageThread,
      });
      downloadArtifact(JSON.stringify(bundle, null, 2), bundleFileName(project.title));
      const messageCount = bundle.conversations.reduce((total, thread) => total + thread.messages.length, 0);
      onNotice(
        `Exported ${project.title} to ${bundleFileName(project.title)}: ${bundle.artifacts.length} artifact${bundle.artifacts.length === 1 ? "" : "s"} and ${messageCount} message${messageCount === 1 ? "" : "s"}.`,
      );
      onChanged();
    } catch (cause) {
      onError(cause);
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
  ) : // INTEGRATE (CL-8756): the workflow could not be read at all — lane-only
  // arm, main has no equivalent; offered so the card never shows a number.
  stageFailed ? (
    <StateLabel tone="error">Status unavailable</StateLabel>
  ) : // INTEGRATE (CL-8756): main's state === "delivered"/"backtracked" arms are
  // dropped — the summary no longer carries state — done comes from the
  // workflow view instead; copy kept.
  done ? (
    <StateLabel tone="success">Delivered</StateLabel>
  ) : project.needsDecision ? (
    <StateLabel tone="warning">{project.waits[0]?.title ?? "Needs your decision"}</StateLabel>
  ) : project.turn === "writing" ? (
    <StateLabel tone="loading">Writing the draft</StateLabel>
  ) : // INTEGRATE (CL-8756): main's turn === "question"/"approve" arms are
  // dropped — the summary turn is only "writing"|"idle" — whose turn it is
  // comes off the stage mail thread instead.
  turn ? (
    <StateLabel tone={turn === "Specialist working" ? "loading" : "warning"}>{turn}</StateLabel>
  ) : stage ? (
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
        {stageFailed ? (
          <span>
            Status unavailable{" "}
            <button type="button" className="link-button" onClick={() => setStageAttempt((attempt) => attempt + 1)}>
              Retry
            </button>
          </span>
        ) : (
          <span>
            Stage {stage || "—"} of 9 · {stageName(stage)}
          </span>
        )}
        <Menu onOpenChange={(open) => !open && setConfirming(false)}>
          <MenuTrigger asChild>
            <button type="button" className="project-card-menu" aria-label={`Options for ${project.title}`}>
              <Ellipsis aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setInfoOpen(true)}>Project info…</MenuItem>
            <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
            {/* INTEGRATE (CL-8756): api.exportProject is gone — exportProject
                above assembles the bundle in the browser instead. Row order,
                label and position stay main's. */}
            <MenuItem disabled={exporting} onSelect={() => void exportProject()}>
              {exporting ? "Exporting…" : "Export…"}
            </MenuItem>
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

      <StageTrack stage={stage} done={done} />

      <div className="project-card-foot">
        {status}
        <span className="project-card-usage inline-note">
          {project.runs} run{project.runs === 1 ? "" : "s"}
        </span>
        <button type="button" className="project-card-open" onClick={onOpen}>
          Open <ArrowRight aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

/** The same nine-segment language the topbar stepper speaks, one per card. */
function StageTrack({ stage, done }: { stage: number | null; done: boolean }) {
  return (
    <div className="stage-track" role="img" aria-label={stage ? `Stage ${stage} of 9` : "Stage unknown"}>
      {Array.from({ length: 9 }, (_, index) => {
        const at = index + 1;
        const cls =
          stage === null ? "" : at < stage || (done && at <= stage) ? "done" : at === stage ? "now" : "";
        return <span key={at} className={cls ? `seg ${cls}` : "seg"} />;
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- spend */

const formatTokens = (count: number): string =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(2)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
// INTEGRATE (CL-8756): SpendTotals is gone with main's client spend shape —
// TokenCounts (project-usage.ts) is the same five counters under a new name.
const totalTokens = (tokens: TokenCounts): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.thinking;
const formatMoney = (amount: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount);
const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * What the workspace has spent on inference, across every project: money
 * where the platform has a price for the model, tokens everywhere, and a
 * plain count of calls that reported no tokens at all. An unknown is shown
 * as one rather than as zero.
 */
// INTEGRATE (CL-8756): main's spend shape is gone on this lane — byProvider,
// uncounted/images counts — so the headline and rows below fold
// project-usage.ts's WorkspaceSpend with formatSpendHeadline. Section,
// order and classNames stay main's.
function SpendBox() {
  const [spend, setSpend] = useState<WorkspaceSpend | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .spend()
      .then((result) => {
        if (!cancelled) setSpend(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!spend) return null;
  const { figure, caption } = formatSpendHeadline(spend);
  return (
    <section className="spend-box" aria-label="Inference spend across projects">
      <div className="spend-headline">
        <span className="spend-figure">{figure}</span>
        <span className="spend-caption">{caption}</span>
      </div>
      <ul className="spend-providers">
        {spend.rows.map((entry) => (
          <li key={`${entry.provider} ${entry.model}`}>
            <strong>{entry.provider}</strong> · {entry.model} · {formatTokens(totalTokens(entry.tokens))} tokens
            {entry.cost !== null ? ` · ${formatMoney(entry.cost, spend.totals.currency)}` : " · unpriced"}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One project, described: when it began, where it stands, and what it holds. */
// INTEGRATE (CL-8756): main's info shape is gone on this lane — stage is a
// bare number, approvals and the per-project spend table (SortableTable,
// SpendRow) no longer exist — so the dialog keeps main's shell and row order
// while usage rides formatUsage and decisions get their own row. Every
// adapted hunk below carries its own note.
function ProjectInfoDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // INTEGRATE (CL-8756): lane-only wiring — what the usage line names as the
  // current model. Behavioral-only; main has no equivalent.
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
      </DialogContent>
    </Dialog>
  );
}
