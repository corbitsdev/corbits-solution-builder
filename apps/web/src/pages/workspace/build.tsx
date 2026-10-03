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
import { api, ApiFailure, type ArtifactNode, type BuildAttempt, type BuildPromptMaterial, type BuildTurn, type BuildWorkerStatus, type ProjectDetail } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { useQuery } from "@tanstack/react-query";
import { keys } from "../../queries/keys.ts";

const NO_TURNS: (BuildTurn | null)[] = [];
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import { Input } from "@corbits/react-ui";
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import { Banner, Button, StateLabel } from "../../components.jsx";
import { ApproveControl } from "./approve-control.tsx";
import { evaluatorStateOf, type StageEvaluator } from "./use-advisory.ts";
import { Markdown } from "../../markdown.jsx";
import { agentFor } from "@solutions-builder/app/kit";
import { StageConversation } from "./thread.jsx";
import { attachedSubjectTags, type AttachedDocument } from "./attach-documents.tsx";
import { appSubject, taggedSubject } from "./composed-mail.ts";
import type { StageEvent } from "./stage-events.ts";
import { StagePanes } from "./workspace-chrome.tsx";
import { clock } from "./elapsed.jsx";
import { localTime } from "../../local-time.ts";
import { BuildFile } from "../graph.jsx";
import { renderStackBlock } from "./frozen-stack-text.ts";
import { attemptOfNode, attemptRecorded, buildArchives, buildEvidenceState, composeSupervisorBrief, forecastSection, probeDecision, supervisorStatus } from "./build-attempts.ts";

const EMPTY_STAGE_EVENTS: readonly StageEvent[] = [];

/** The frozen version of a kind, when the freeze names one, as a node that
 *  reads exactly that version (a document kept in one artifact may have
 *  moved past it); else the live node. */
function frozenNode(nodes: readonly ArtifactNode[], freeze: Freeze | null, kind: string): ArtifactNode | undefined {
  for (const ref of freeze?.frozen ?? []) {
    const held = nodes.find((node) => node.artifactId === ref.artifactId && node.kind === kind);
    if (held) return { ...held, id: versionIdFor(ref.artifactId, ref.version), version: ref.version };
  }
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
): Promise<BuildPromptMaterial> {
  const plan = frozenNode(nodes, freeze, "build_plan");
  const requirements = frozenNode(nodes, freeze, "product_requirements");
  // A freeze with no stage 4 reference had GUI design skipped: a design left
  // from before the project's surface changed is not material.
  const design = freeze && !freeze.frozen.some((ref) => ref.stage === 4) ? undefined : frozenNode(nodes, freeze, "design_artifact");
  const [planText, requirementsText, designText] = await Promise.all([
    plan ? read(plan.id) : Promise.resolve(""),
    requirements ? read(requirements.id) : Promise.resolve(""),
    design ? read(design.id) : Promise.resolve(""),
  ]);
  return {
    planText,
    requirementsText,
    designText,
    stackBlock: renderStackBlock(freeze) ?? "",
    target: freeze?.target ?? "",
    planRef: plan ? `${plan.artifactId}@${String(plan.version)}` : "",
  };
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

/** Each turn as the worker reported it: what it said, and one plain line per tool call. */
function WorkerTurns({ turns }: { turns: readonly (BuildTurn | null)[] }) {
  return (
    <div aria-live="polite">
      {turns.map((turn, index) =>
        turn === null ? (
          <p key={index} className="inline-note">
            A turn report the host could not read.
          </p>
        ) : (
          <div key={index}>
            {turn.said ? <Markdown source={turn.said} /> : null}
            {turn.tools.map((tool, call) => (
              <p key={call} className="inline-note">
                {tool.action}
                {tool.path ? (
                  <>
                    {" "}
                    <code>{tool.path}</code>
                  </>
                ) : null}
                {tool.failed ? " — failed" : ""}
              </p>
            ))}
          </div>
        ),
      )}
    </div>
  );
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
  address,
  messages,
  reloadThread,
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
  documents,
  documentLabels,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  /** The build supervisor's live address and its thread across every address
   *  it has run at (`useStageAgent`, `useStageThread`), read through the
   *  workspace's query cache so a reopened project shows what was sent. */
  address: string;
  messages: readonly ChatMessage[];
  reloadThread: () => Promise<void>;
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
  /** "Upload a file": files join the project as material. */
  onAttach?: (files: FileList) => void;
  documents?: readonly AttachedDocument[];
  documentLabels?: ReadonlyMap<string, string>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [worker, setWorker] = useState<BuildWorkerStatus | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [startCommand, setStartCommand] = useState("");
  const [port, setPort] = useState("");

  // The worker's presence is the host's word, asked for on open and again
  // whenever the window regains focus: a person installs the tool in a
  // terminal, or changes it in Settings, and comes back expecting the
  // panel to know.
  const checkWorker = useCallback(async () => {
    try {
      setWorker(await api.buildWorker());
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void checkWorker();
    const onFocus = () => void checkWorker();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkWorker]);

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
  // A failed read keeps the last log; the next poll says.
  const view = useQuery({
    queryKey: [...keys.buildAttempts.log(detail.project.id, current?.attempt ?? 0), current?.state],
    queryFn: () => api.buildAttempt(detail.project.id, current!.attempt),
    enabled: current !== null,
    refetchInterval: current?.state === "running" ? 2_000 : false,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === current?.attempt ? previous : undefined),
  }).data;
  const log = view?.log ?? "";
  const turns = view?.turns ?? NO_TURNS;

  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  const run = async (label: string, work: () => Promise<void>): Promise<boolean> => {
    setBusy(label);
    setError(null);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      return false;
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
      if (!attempt.outcome) return;
      // The target probed is the one stage 7 froze, started as the attempt's run.json declares unless the fields say otherwise; its tests run either way.
      const probe = probeDecision({ startCommand, port, frozenTarget: freeze?.target ?? null });
      const { packaged } = await api.packageBuildAttempt(detail.project.id, attempt.attempt, { targets: [...probe.targets], target: freeze?.target?.trim() || "web" });
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
        subject: appSubject("brief", String(attempt.attempt)),
        body: composeSupervisorBrief({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          archive: { fileName: packaged.fileName, sha256: packaged.sha256, sizeBytes: packaged.sizeBytes, files: packaged.manifest.files.map((file) => file.path), fileCount: packaged.manifest.fileCount },
          probeSkipped: probe.skipped,
          forecast,
          verification: packaged.verification,
        }),
      });
      await Promise.all([reloadThread(), refreshAttempts()]);
      onChanged();
    });

  const archive = useMemo(() => buildArchives(detail.nodes)[0], [detail.nodes]) as ArtifactNode | undefined;
  const evidence = useMemo(() => buildEvidenceState(detail.nodes, attempts), [detail.nodes, attempts]);
  const archiveAttempt = archive ? attemptOfNode(archive) : null;
  const status = useMemo(() => (archiveAttempt === null ? null : supervisorStatus(messages, archiveAttempt)), [messages, archiveAttempt]);
  // The supervisor is this stage's evaluator: its verdict on the recorded attempt, read from the status's own Verdict line.
  const verdict = useMemo((): StageEvaluator => {
    if (!status) return { status: "unavailable", reason: "No recorded attempt has been read by the build supervisor yet." };
    if (!status.reply) return { status: "checking" };
    const at = status.reply.body.search(/^Verdict:/im);
    return at < 0 ? { status: "unavailable", reason: "The build supervisor's status gives no verdict." } : evaluatorStateOf({ ...status.reply, body: status.reply.body.slice(at) });
  }, [status]);
  const state = running ? { label: "working", tone: "selected" as const } : current ? attemptLabel(current) : { label: "idle", tone: "info" as const };
  const canRecord = current !== null && current.state === "ended" && current.outcome !== null && !attemptRecorded(detail.nodes, current.attempt);
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
          <StageConversation
            messages={messages}
            draftPane={false}
            value={composer}
            onValueChange={setComposer}
            onSend={(attached) => {
              const body = composer;
              setComposer("");
              return run("message", async () => {
                const tags = await attachedSubjectTags(tenantId, attached);
                await api.sendStageMail(tenantId, address, { body, ...taggedSubject(tags, body) });
                await reloadThread();
              });
            }}
            working={busy !== null}
            events={stageEvents}
            who={agentFor(8).title}
            empty={`Nothing has been sent to the ${agentFor(8).title.toLowerCase()} yet. It reads each attempt once the attempt is recorded.`}
            {...(onSendHold ? { onSendHold: () => onSendHold(composer) } : {})}
            {...(onAttach ? { onAttach } : {})}
            {...(documents ? { documents } : {})}
            {...(documentLabels ? { documentLabels } : {})}
            popover={popover}
            rows={
              canApprove || evidence.reason ? (
                <ApproveControl evaluator={verdict} waiting={evidence.reason} busy={approving} onApprove={onApprove} />
              ) : null
            }
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
            {/* Only what can act now: a start while nothing runs, a continue
                once an attempt's directory exists, a cancel while one runs. */}
            <div className="document-tools">
              {cancellable ? (
                <Button variant="destructive" loading={busy === "cancel"} disabled={busy !== null} onClick={() => void cancel(cancellable.attempt)}>
                  Cancel the build attempt
                </Button>
              ) : (
                <>
                  <Button variant={canApprove ? "secondary" : "primary"} loading={busy === "start"} disabled={busy !== null} onClick={() => void start()}>
                    {attempts.length > 0 ? "Start a new attempt" : "Start the build attempt"}
                  </Button>
                  {lastEnded ? (
                    <Button variant="secondary" loading={busy === "continue"} disabled={busy !== null} onClick={() => void start(lastEnded.attempt)}>
                      Continue from attempt {String(lastEnded.attempt)}
                    </Button>
                  ) : null}
                </>
              )}
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
                      {entry.startedAt ? ` · ${localTime(entry.startedAt)}` : ""}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {current ? (
              <>
                <h2>Attempt {String(current.attempt)} — what the worker wrote</h2>
                {current.state === "ended" && current.outcome?.finalText.trim() ? (
                  // Once the worker is done its final text is a report, written
                  // in Markdown; the stream it came from stays one click away.
                  <>
                    <Markdown source={current.outcome.finalText} />
                    <details className="build-log-fold">
                      <summary>Full log</summary>
                      <pre ref={logRef} className="build-log">
                        {log || "The worker wrote nothing."}
                      </pre>
                    </details>
                  </>
                ) : turns.length > 0 ? (
                  // The worker's own turn reports, said readably; the raw
                  // stream they came from stays one click away.
                  <>
                    <WorkerTurns turns={turns} />
                    <details className="build-log-fold">
                      <summary>Full log</summary>
                      <pre ref={logRef} className="build-log">
                        {log}
                      </pre>
                    </details>
                  </>
                ) : (
                  <pre ref={logRef} className="build-log" aria-live="polite">
                    {log || (current.state === "running" ? "Waiting for the worker's first output…" : "The worker wrote nothing.")}
                  </pre>
                )}
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
                  <div className="build-record">
                    <Input
                      aria-label="Start command"
                      placeholder={`Start command for the ${freeze?.target?.trim() || "web"} target, e.g. npm start (optional; replaces run.json's)`}
                      value={startCommand}
                      onChange={(event) => setStartCommand(event.target.value)}
                    />
                    <Input
                      aria-label="Port"
                      placeholder="Port"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      style={{ maxWidth: "6rem" }}
                    />
                    <Button variant="primary" loading={busy === "record"} disabled={busy !== null} onClick={() => void record(current)}>
                      Record attempt {String(current.attempt)} and brief the supervisor
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="inline-note">No attempt has been started. The worker builds in its own directory on this computer, from the frozen plan, requirements, design and stack.</p>
            )}
            {archive ? <BuildFile node={archive} nodes={detail.nodes} tenantId={tenantId} /> : null}
            {status ? (
              <>
                <h2>Build status — {agentFor(8).title}</h2>
                {status.reply ? (
                  <Markdown source={status.reply.body} />
                ) : (
                  <p className="inline-note">Waiting on the {agentFor(8).title.toLowerCase()} to read attempt {String(status.attempt)}'s record.</p>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </StagePanes>
  );
}
