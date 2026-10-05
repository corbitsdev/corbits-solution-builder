/**
 * Stage 8: the build, driven through the host's bounded bridge, and the
 * Build supervisor who reads what the worker reported.
 *
 * The build is not done by the stage's specialist. The host runs one coding
 * agent's non-interactive form in `attempts/<n>/` under the project's build
 * directory (`apps/hub/src/corbits-exec.ts`, `build-attempts.ts`) and
 * reports its stdout and stderr as written, its final text and its exit
 * status — nothing synthesised: no sessions, steering or checkpoints,
 * because the interface has none. This panel starts, continues and cancels
 * those attempts and shows the log as it grows.
 *
 * When an attempt has ended, "Record" has the host package it — the same
 * archive, hashes and target probes `publish_workspace` ran when the build
 * was a sidecar tool — records the archive as the stage's `build_evidence`
 * with the host as its producer (so it is the reviewable artifact,
 * `stage-approval.ts`'s `reviewableArtifact`), and briefs the supervisor
 * with the record. The supervisor's reply is the build status document;
 * the review opens on the archive (`use-stage-decisions.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QUESTIONS_MD, agentsInstructions } from "@solutions-builder/app/agents-instructions";
import { api, ApiFailure, type ArtifactNode, type BuildAttempt, type BuildPromptMaterial, type BuildWorkerStatus, type BuildWorkspaceReport, type ProjectDetail } from "../../client.js";
import { openQuestions, planTasks, progressHeadline, taskProgress } from "./build-progress.ts";
import { slug } from "../../documents-archive.ts";
import { DEFAULT_LANGUAGE_SETTINGS, languageLabel } from "@solutions-builder/app/language-settings";
import type { ChatMessage } from "../../stage-mail.ts";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import { Banner, Button, StateLabel } from "../../components.jsx";
import { Markdown } from "../../markdown.jsx";
import { agentFor } from "@solutions-builder/app/kit";
import type { StageEvent } from "./stage-events.ts";
import { StageConversation } from "./thread.jsx";
import { StagePanes } from "./workspace-chrome.tsx";
import { clock } from "./elapsed.jsx";
import { BuildFile } from "../graph.jsx";
import { renderStackBlock } from "./frozen-stack-text.ts";
import { attemptRecorded, buildArchives, buildEvidenceState, composeProgressBrief, composeSupervisorBrief, forecastSection, latestTurn, probeDecision, progressBriefDue, statusFreshness } from "./build-attempts.ts";

const EMPTY_STAGE_EVENTS: readonly StageEvent[] = [];

/** The frozen version of a kind, when the freeze names one; else the live node. */
function frozenNode(nodes: readonly ArtifactNode[], freeze: Freeze | null, kind: string): ArtifactNode | undefined {
  const frozen = freeze?.frozen.find((ref) => nodes.some((node) => node.artifactId === ref.artifactId && node.version === ref.version && node.kind === kind));
  if (frozen) return nodes.find((node) => node.artifactId === frozen.artifactId && node.version === frozen.version);
  return nodes
    .filter((node) => node.kind === kind && node.supersededByNodeId === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/**
 * The frozen material the host assembles the worker's packet from: the
 * approved plan, the requirements it cites, the stage 4 design and the
 * stack and target stage 7 froze. Read once per attempt; the host writes
 * the assembled packet beside the attempt, immutable.
 */
export async function buildPromptMaterial(
  tenantId: string,
  nodes: readonly ArtifactNode[],
  freeze: Freeze | null,
  read: (nodeId: string) => Promise<string> = (nodeId) => api.artifactContent(tenantId, nodeId).then((result) => result.content),
  language: () => Promise<string> = outputLanguage,
): Promise<BuildPromptMaterial> {
  const plan = frozenNode(nodes, freeze, "build_plan");
  const requirements = frozenNode(nodes, freeze, "product_requirements");
  const design = frozenNode(nodes, freeze, "design_artifact");
  const [planText, requirementsText, designText, settings] = await Promise.all([
    plan ? read(plan.id) : Promise.resolve(""),
    requirements ? read(requirements.id) : Promise.resolve(""),
    design ? read(design.id) : Promise.resolve(""),
    language(),
  ]);
  return {
    planText,
    requirementsText,
    designText,
    stackBlock: renderStackBlock(freeze) ?? "",
    target: freeze?.target ?? "",
    planRef: plan ? `${plan.artifactId}@${String(plan.version)}` : "",
    files: workspaceFiles({ planText, requirementsText, designText }, settings),
    language: settings,
  };
}

/** The workspace's output language, by name (#733): what the build's documents are written in. */
async function outputLanguage(): Promise<string> {
  try {
    return languageLabel((await api.languageSettings()).output);
  } catch {
    return languageLabel(DEFAULT_LANGUAGE_SETTINGS.output);
  }
}

/**
 * The corpus a coding agent works from, as files in its workspace (#686):
 * AGENTS.md first, then the PRD, the plan, the design when it is an HTML
 * document, and an empty QUESTIONS.md for the decisions it must not make.
 */
export function workspaceFiles(texts: { planText: string; requirementsText: string; designText: string }, language?: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const designIsHtml = /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(texts.designText);
  if (texts.requirementsText) files.push({ path: "product-requirements.md", content: texts.requirementsText });
  if (texts.planText) files.push({ path: "build-plan.md", content: texts.planText });
  if (texts.designText) files.push({ path: designIsHtml ? "design.html" : "design.md", content: texts.designText });
  if (texts.requirementsText) {
    files.unshift({
      path: "AGENTS.md",
      content: agentsInstructions(
        { requirements: "product-requirements.md", design: texts.designText ? (designIsHtml ? "design.html" : "design.md") : null, mockups: null, plan: texts.planText ? "build-plan.md" : null },
        texts.requirementsText,
        language,
      ),
    });
    files.push({ path: "QUESTIONS.md", content: QUESTIONS_MD });
  }
  return files;
}

/** Counts up from `since`, or shows nothing until there is one. */
function BuildClock({ since, until }: { since: string | null; until: string | null }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!since) return;
    const started = Date.parse(since);
    const tick = () => setSeconds(Math.max(0, Math.floor(((until ? Date.parse(until) : Date.now()) - started) / 1000)));
    tick();
    if (until) return;
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [since, until]);
  if (!since) return null;
  return (
    <span className="elapsed-clock" role="timer" aria-live="off">
      {clock(seconds)}
    </span>
  );
}

/** Mockup `.ev` tone classes: pass / fail / working / queued. */
const EV_TONE: Record<"info" | "selected" | "success" | "error" | "warning", "p" | "f" | "w" | "r"> = {
  success: "p",
  error: "f",
  warning: "w",
  selected: "w",
  info: "r",
};

function evMark(tone: keyof typeof EV_TONE): string {
  if (tone === "success") return "✓ ";
  if (tone === "error") return "✗ ";
  if (tone === "warning" || tone === "selected") return "… ";
  return "";
}

function attemptLabel(attempt: BuildAttempt): { label: string; tone: "warning" | "selected" | "success" | "info" | "error" } {
  if (attempt.state === "running") return { label: "working", tone: "selected" };
  if (attempt.state === "detached") return { label: "still running from before the host restarted; not followed here", tone: "warning" };
  if (attempt.state === "lost") return { label: "lost: the host was stopped without ending it, and the worker is gone", tone: "error" };
  if (attempt.state === "unavailable") return { label: "could not run", tone: "error" };
  const outcome = attempt.outcome;
  if (!outcome) return { label: "ended", tone: "info" };
  if (outcome.signal) return { label: `ended by ${outcome.signal}`, tone: "warning" };
  // An exit status is reported, never coloured: zero is not evidence the
  // build is right, and a person reads the record, not a tick.
  return { label: `exited ${String(outcome.exitStatus ?? "?")}`, tone: outcome.exitStatus === 0 ? "info" : "warning" };
}

export function BuildPanel({
  detail,
  tenantId,
  freeze,
  attempts,
  refreshAttempts,
  onChanged,
  onOpenSettings,
  onApprove,
  approving,
  canApprove,
  strip = null,
  reader = null,
  stageEvents = EMPTY_STAGE_EVENTS,
  onSendHold,
  popover = null,
  onAttach,
  attachNote = null,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  /** Stage 7's freeze: the target, the frozen references and the stack. */
  freeze: Freeze | null;
  /** The host's attempts for this project (`useBuildAttempts`). */
  attempts: readonly BuildAttempt[];
  refreshAttempts: () => Promise<void>;
  onChanged: () => void;
  onOpenSettings: () => void;
  onApprove: () => void;
  approving: boolean;
  canApprove: boolean;
  /** The artifact tabs + version strip the pane shares with every stage. */
  strip?: ReactNode;
  /** What the pane shows while another stage's artifact tab is selected. */
  reader?: ReactNode;
  /** The stage's event record, folded into the transcript. */
  stageEvents?: readonly StageEvent[];
  /** Holding send raises the send-back picker. */
  onSendHold?: (draft: string) => void;
  popover?: ReactNode;
  /** The paperclip: files join the project as material. */
  onAttach?: (files: FileList) => void;
  attachNote?: string | null;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [worker, setWorker] = useState<BuildWorkerStatus | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [log, setLog] = useState("");
  const [report, setReport] = useState<BuildWorkspaceReport | null>(null);
  const [planText, setPlanText] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [port, setPort] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .ensureStageAgent(detail.project.id, 8)
      .then((deployment) => {
        if (!cancelled) setAddress(deployment.address);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);

  // The worker's presence is the host's word, asked for on open and again
  // whenever the window regains focus: a person installs the tool in a
  // terminal, or changes it in Settings, and comes back expecting the
  // panel to know.
  const checkWorker = useCallback(async () => {
    try {
      setWorker(await api.buildWorker());
    } catch {
      // The banner keeps the last answer; the next check says.
    }
  }, []);
  useEffect(() => {
    void checkWorker();
    const onFocus = () => void checkWorker();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkWorker]);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      setMessages(await api.readStageThread(tenantId, [address]));
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  }, [address, tenantId]);

  useEffect(() => {
    if (!address) return;
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [address, load]);

  // The project detail (and so `detail.nodes`) follows this stage's thread:
  // a supervisor reply is the only cue that the status document changed.
  const lastMessageCount = useRef(0);
  useEffect(() => {
    if (messages.length > lastMessageCount.current) onChanged();
    lastMessageCount.current = messages.length;
  }, [messages, onChanged]);

  const latest = attempts.at(-1) ?? null;
  const running = attempts.find((entry) => entry.state === "running") ?? null;
  // A detached worker can still be cancelled: the host signals its group.
  const cancellable = running ?? attempts.find((entry) => entry.state === "detached") ?? null;
  const current = useMemo(() => attempts.find((entry) => entry.attempt === selected) ?? latest, [attempts, selected, latest]);

  // The log of the attempt in view: polled while it runs, read once when it
  // has ended. Both pipes and the worker's turn reports, in arrival order.
  useEffect(() => {
    if (!current) {
      setLog("");
      setReport(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const result = await api.buildAttempt(detail.project.id, current.attempt);
        if (cancelled) return;
        setLog(result.log);
        // A host from before #697 sends no report; progress then rests on the turn lines.
        setReport(result.workspaceReport ?? null);
      } catch {
        // The next poll says.
      }
    };
    void read();
    if (current.state !== "running") return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void read(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detail.project.id, current?.attempt, current?.state]);

  // While the worker runs, the supervisor is briefed on its progress at
  // intervals (#695) and writes an interim status; the thread poll shows
  // it. The thread says what was already sent, so a reload never repeats.
  const briefing = useRef(false);
  useEffect(() => {
    if (!address || !running || !running.startedAt || briefing.current) return;
    const due = progressBriefDue({ messages, attempt: running.attempt, startedAt: running.startedAt, turn: latestTurn(log), now: new Date().toISOString() });
    if (!due) return;
    briefing.current = true;
    const body = composeProgressBrief({ attempt: running.attempt, startedAt: running.startedAt, now: new Date().toISOString(), log, worker: worker?.worker.label ?? null });
    api
      .sendStageMail(tenantId, address, { body })
      .then(() => load())
      .catch(() => {
        // The next poll tries again.
      })
      .finally(() => {
        briefing.current = false;
      });
  }, [address, running, log, messages, tenantId, load, worker]);

  // The plan the attempt was built from, for its task list (#697): the
  // frozen version when there is a freeze, read once per project.
  useEffect(() => {
    let cancelled = false;
    const plan = frozenNode(detail.nodes, freeze, "build_plan");
    if (!plan) {
      setPlanText("");
      return;
    }
    api
      .artifactContent(tenantId, plan.id)
      .then((result) => {
        if (!cancelled) setPlanText(result.content);
      })
      .catch(() => {
        // Without the plan the tally counts commits alone.
      });
    return () => {
      cancelled = true;
    };
  }, [detail.nodes, freeze, tenantId]);
  const tasks = useMemo(() => planTasks(planText), [planText]);
  const progress = useMemo(() => taskProgress(tasks, report, log), [tasks, report, log]);

  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const start = (continueFrom?: number) =>
    run(continueFrom === undefined ? "start" : "continue", async () => {
      const material = await buildPromptMaterial(tenantId, detail.nodes, freeze);
      const started = await api.startBuildAttempt(detail.project.id, material, continueFrom);
      setSelected(started.attempt.attempt);
      await refreshAttempts();
    });

  const cancel = (attempt: number) =>
    run("cancel", async () => {
      await api.cancelBuildAttempt(detail.project.id, attempt);
      await refreshAttempts();
    });

  // Package on the host, record the archive under the supervisor's role,
  // and brief the supervisor with the record. The archive is what the
  // review opens on; the brief is what the status is written from.
  const record = (attempt: BuildAttempt) =>
    run("record", async () => {
      if (!address || !attempt.outcome) return;
      // Packaging an attempt that is already recorded (#727) writes a
      // newer archive and manifest, which take over from the earlier ones.
      const repackaged = attemptRecorded(detail.nodes, attempt.attempt);
      // The target probed is the one stage 7 froze; the fields say how to start it.
      const probe = probeDecision({ startCommand, port, frozenTarget: freeze?.target ?? null });
      // The archive and the one folder it unpacks into are named for the
      // project and attempt (#699), so unpacking never spills into the
      // directory around it.
      const archiveName = `${slug(detail.project.title)}-attempt-${String(attempt.attempt)}`;
      const { packaged } = await api.packageBuildAttempt(detail.project.id, attempt.attempt, { fileName: `${archiveName}.tar.gz`, root: archiveName, targets: [...probe.targets] });
      // Stage 7's forecast, for the supervisor's "Cost against forecast": the
      // frozen estimate's own section, or nothing, said as nothing.
      const estimate = frozenNode(detail.nodes, freeze, "cost_approval");
      const forecast = estimate ? forecastSection((await api.artifactContent(tenantId, estimate.id).catch(() => ({ content: "" }))).content) : null;
      await api.persistBuildEvidence(detail.project.id, {
        fileName: packaged.fileName,
        mediaType: packaged.mediaType,
        dataUri: packaged.dataUri,
        sizeBytes: packaged.sizeBytes,
        manifest: packaged.manifest,
      });
      await api.sendStageMail(tenantId, address, {
        body: composeSupervisorBrief({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          archive: { fileName: packaged.fileName, sha256: packaged.sha256, sizeBytes: packaged.sizeBytes, fileCount: packaged.manifest.fileCount },
          probeSkipped: probe.skipped,
          forecast,
          verification: packaged.verification,
          ...(repackaged ? { repackaged: true } : {}),
        }),
      });
      await Promise.all([load(), refreshAttempts()]);
      onChanged();
    });

  const archive = useMemo(() => buildArchives(detail.nodes)[0], [detail.nodes]) as ArtifactNode | undefined;
  const evidence = useMemo(() => buildEvidenceState(detail.nodes, attempts), [detail.nodes, attempts]);
  const status = useMemo(() => [...messages].reverse().find((message) => message.author === "agent") ?? null, [messages]);
  const freshness = useMemo(() => (status ? statusFreshness(messages, status, current) : null), [messages, status, current]);
  const state = running ? { label: "working", tone: "selected" as const } : current ? attemptLabel(current) : { label: "idle", tone: "info" as const };
  const ended = current !== null && current.state === "ended" && current.outcome !== null;
  const recorded = current !== null && attemptRecorded(detail.nodes, current.attempt);
  const canRecord = ended && !recorded;
  const lastEnded = [...attempts].reverse().find((entry) => entry.state === "ended") ?? null;

  return (
    <StagePanes
      tour="build-panel"
      strip={strip}
      conversation={
        <>
          {error ? (
            <Banner tone="error" title="The build attempt could not be changed" action={{ label: "Open Settings", onClick: onOpenSettings }}>
              {error}
            </Banner>
          ) : null}
          {!address ? (
            <div className="think" role="status">
              <span className="who conv-who">Opening…</span>
            </div>
          ) : null}
          <StageConversation
            stage={8}
            rows={attachNote ? <p className="warning-note" role="alert">{attachNote}</p> : null}
            messages={messages}
            value={composer}
            onValueChange={setComposer}
            onSend={() => {
              const body = composer;
              setComposer("");
              void run("message", async () => {
                if (!address) return;
                await api.sendStageMail(tenantId, address, { body });
                await load();
              });
            }}
            working={busy !== null}
            disabled={!address}
            events={stageEvents}
            who={agentFor(8).title}
            {...(onSendHold ? { onSendHold: () => onSendHold(composer) } : {})}
            {...(onAttach ? { onAttach } : {})}
            popover={popover}
          />
        </>
      }
    >
      {reader ?? (
        <div className="stage-inner">
          <div className="doc">
            <h1>Build Evidence</h1>
            <div className="docmeta">
              <span>
                <StateLabel tone={state.tone}>{state.label}</StateLabel>
                {" · "}
                {worker ? `${worker.worker.label}${worker.available ? "" : " (not on this computer)"}` : agentFor(8).title}
                {current?.startedAt ? (
                  <>
                    {" · attempt "}
                    {String(current.attempt)}
                    {" · "}
                    <BuildClock since={current.startedAt} until={current.endedAt} />
                  </>
                ) : null}
              </span>
            </div>
            {worker && !worker.available ? (
              <Banner tone="error" title={worker.detail} action={{ label: "Open Settings", onClick: onOpenSettings }}>
                {worker.install ? worker.install.text : "Choose a coding agent that is installed, or give its path, in Settings."}{" "}
                <button type="button" className="btn link" onClick={() => void checkWorker()}>
                  Check again
                </button>
              </Banner>
            ) : null}
            <div className="document-tools">
              <Button variant="primary" loading={busy === "start"} disabled={!!running || busy !== null} onClick={() => void start()}>
                Start the build attempt
              </Button>
              <Button
                variant="primary"
                loading={busy === "continue"}
                disabled={!!running || busy !== null || lastEnded === null}
                onClick={() => lastEnded && void start(lastEnded.attempt)}
              >
                {lastEnded ? `Continue from attempt ${String(lastEnded.attempt)}` : "Continue from the last attempt"}
              </Button>
              <Button variant="destructive" loading={busy === "cancel"} disabled={!cancellable || busy !== null} onClick={() => cancellable && void cancel(cancellable.attempt)}>
                Cancel the build attempt
              </Button>
              <Button variant="primary" loading={approving} disabled={!canApprove || !address} onClick={onApprove}>
                Approve and continue
              </Button>
            </div>
            {attempts.length > 0 ? (
              <div className="ev">
                {attempts.map((entry) => {
                  const mark = attemptLabel(entry);
                  return (
                    <span key={entry.attempt} className={EV_TONE[mark.tone]} role="button" tabIndex={0} onClick={() => setSelected(entry.attempt)} onKeyDown={(event) => event.key === "Enter" && setSelected(entry.attempt)}>
                      {evMark(mark.tone)}
                      {entry.attempt === current?.attempt ? <b>attempt {String(entry.attempt)}</b> : `attempt ${String(entry.attempt)}`}
                      {entry.continuedFrom !== null ? ` (continued from ${String(entry.continuedFrom)})` : ""}
                      {" — "}
                      {mark.label}
                      {entry.startedAt ? ` · ${new Date(entry.startedAt).toLocaleString()}` : ""}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {current ? (
              <>
                <h2>Build progress</h2>
                <p className="build-headline">{progressHeadline(current, progress)}</p>
                {progress.tasks.length > 0 ? (
                  <>
                    <div className="build-meter" role="img" aria-label={`${String(progress.committed)} of ${String(progress.tasks.length)} tasks committed, ${String(progress.started)} under way`}>
                      <span className="build-meter-done" style={{ flexGrow: progress.committed }} />
                      <span className="build-meter-started" style={{ flexGrow: progress.started }} />
                      <span className="build-meter-rest" style={{ flexGrow: progress.unnamed }} />
                    </div>
                    <details className="bubble-fold" open={current.state !== "running"}>
                      <summary>
                        The plan's {String(progress.tasks.length)} tasks: {String(progress.committed)} committed, {String(progress.started)} under way, {String(progress.unnamed)} not yet named
                      </summary>
                      <div className="ev build-tasks">
                        {progress.tasks.map((task) => (
                          <span key={task.number} className={task.state === "committed" ? "p" : task.state === "started" ? "w" : "r"} title={task.evidence ?? "Not named in any commit, status section or turn line"}>
                            {task.state === "committed" ? "✓ " : task.state === "started" ? "… " : ""}
                            <b>Task {String(task.number)}</b> {task.title}
                            {task.evidence ? <i className="build-task-evidence"> — {task.evidence}</i> : null}
                          </span>
                        ))}
                      </div>
                    </details>
                  </>
                ) : null}
                {report?.documents ? (
                  // The two documents every build ships (#733), as the directory holds them.
                  <div className="ev build-tasks">
                    <span className={report.documents.readme ? "p" : "f"}>
                      {report.documents.readme ? "✓ " : "✗ "}
                      <b>README.md</b> for the installer, sysadmin or IT person{report.documents.readme ? "" : " — missing"}
                    </span>
                    <span className={report.documents.userManual ? "p" : "f"}>
                      {report.documents.userManual ? "✓ " : "✗ "}
                      <b>docs/USER-MANUAL.md</b> for the people who use it
                      {report.documents.userManual
                        ? `, with ${String(report.documents.manualImages)} picture${report.documents.manualImages === 1 ? "" : "s"}${report.documents.manualImages === 0 ? " (none yet)" : ""}`
                        : " — missing"}
                    </span>
                  </div>
                ) : null}
                {report?.status ? (
                  <details className="bubble-fold">
                    <summary>The worker's own status report (STATUS.md)</summary>
                    <Markdown source={report.status} />
                  </details>
                ) : null}
                {report?.questions && openQuestions(report.questions) > 0 ? (
                  <details className="bubble-fold">
                    <summary>
                      {String(openQuestions(report.questions))} decision{openQuestions(report.questions) === 1 ? "" : "s"} the worker left to you (QUESTIONS.md)
                    </summary>
                    <Markdown source={report.questions} />
                  </details>
                ) : null}
                {current.state === "ended" && current.outcome?.finalText.trim() ? (
                  <details className="bubble-fold">
                    <summary>What the worker said at the end</summary>
                    <Markdown source={current.outcome.finalText.slice(-20_000)} />
                  </details>
                ) : null}
                <h2>Attempt {String(current.attempt)} — what the worker wrote</h2>
                <pre ref={logRef} className="build-log" aria-live="polite" style={{ maxHeight: "24rem", overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {log || (current.state === "running" ? "Waiting for the worker's first output…" : "The worker wrote nothing.")}
                </pre>
                {current.outcome ? (
                  <p className="inline-note">
                    {current.outcome.available
                      ? `${current.outcome.worker} ${current.outcome.signal ? `ended by ${current.outcome.signal}` : `exited ${String(current.outcome.exitStatus)}`}` +
                        (current.outcome.turns !== null ? ` after ${String(current.outcome.turns)} turns and ${String(current.outcome.toolCalls ?? 0)} tool calls.` : ".")
                      : current.outcome.stderrTail}
                  </p>
                ) : null}
                {current.state === "ended" && current.outcome?.available && current.outcome.finalText.trim().length === 0 ? (
                  // Ended with nothing to report: what is in the directory is
                  // still there, and the way on is to continue from it.
                  <div className="document-tools">
                    <p className="inline-note">The worker ended without a report. Its directory is kept; a new attempt can continue from it.</p>
                    <Button variant="primary" loading={busy === "continue"} disabled={!!running || busy !== null} onClick={() => void start(current.attempt)}>
                      Continue from attempt {String(current.attempt)}'s directory
                    </Button>
                  </div>
                ) : null}
                {canRecord ? (
                  <div className="document-tools">
                    <input
                      className="field"
                      aria-label="Start command"
                      placeholder={`Start command for the ${freeze?.target?.trim() || "web"} target, e.g. npm start (optional)`}
                      value={startCommand}
                      onChange={(event) => setStartCommand(event.target.value)}
                    />
                    <input
                      className="field"
                      aria-label="Port"
                      placeholder="Port"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      style={{ maxWidth: "6rem" }}
                    />
                    <Button variant="primary" loading={busy === "record"} disabled={busy !== null || !address} onClick={() => void record(current)}>
                      Record attempt {String(current.attempt)} and brief the supervisor
                    </Button>
                  </div>
                ) : null}
                {ended && recorded ? (
                  // Already recorded (#727): the same step again, for a new
                  // archive layout or a probe with a start command this time.
                  <div className="document-tools">
                    <input className="field" aria-label="Start command" placeholder={`Start command for the ${freeze?.target?.trim() || "web"} target, e.g. npm start (optional)`} value={startCommand} onChange={(event) => setStartCommand(event.target.value)} />
                    <input className="field" aria-label="Port" placeholder="Port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} style={{ maxWidth: "6rem" }} />
                    <Button variant="secondary" loading={busy === "record"} disabled={busy !== null || !address || !!running} onClick={() => void record(current)}>
                      Re-archive attempt {String(current.attempt)}'s files
                    </Button>
                    <p className="inline-note">No build runs. The directory the worker left is packaged again as it is, a new archive and manifest are written beside the earlier ones, and the supervisor is briefed on the new record.</p>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="inline-note">No attempt has been started. The worker builds in its own directory on this computer, from the frozen plan, requirements, design and stack.</p>
            )}
            {archive ? <BuildFile node={archive} nodes={detail.nodes} tenantId={tenantId} /> : null}
            {status ? (
              <>
                <h2>
                  Build status — {agentFor(8).title}
                  {freshness ? <span className="inline-note"> · {freshness}</span> : null}
                </h2>
                <Markdown source={status.body} />
              </>
            ) : null}
            {!canApprove && evidence.reason ? <p className="inline-note">{evidence.reason}</p> : null}
          </div>
        </div>
      )}
    </StagePanes>
  );
}
