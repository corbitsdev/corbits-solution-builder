/**
 * Stage 8: build supervision, talking to the stage's own mail agent.
 *
 * Contract v6 gives stage 8 a posix tool inside its own single-step run
 * rather than a separate host build-worker bridge with its own signal
 * chain, so there is no lifecycle run to park a build attempt's state on
 * any more -- "start"/"cancel"/"accept"/"fail" are sent as plain mail, the
 * same way any other stage's specialist is talked to (see index.tsx's own
 * account of the cutover). The rich timeline the old bridge reported (a
 * state label, exit status, packaged archive, live output, an elapsed
 * clock, an event log) is rebuilt here from what the stage's own run
 * already exposes: the hub approval each `run_shell` call parks on
 * (CL-8566), the run's own committed event log, and the mail thread's
 * replies -- CL-8621 follow-up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode, type ProjectDetail } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { Banner, Button, Screen, StateLabel } from "../../components.jsx";
import { StageConversation } from "./thread.jsx";
import { clock } from "./elapsed.jsx";
import { BuildFile } from "../graph.jsx";
import { createHubTransport } from "../../hub.ts";
import { approveTool, pendingApprovals, rejectTool, type PendingApproval } from "../../pending-approvals.ts";

/** The run_shell tool's declared name — every stage-8 approval this panel
 *  turns into a timeline row is parked on a tool call by this name. */
const RUN_SHELL_TOOL_NAME = "run_shell";

/** `publish_workspace`'s own declared name (`packages/tools-delivery/src/
 *  publish-workspace.ts`'s `TOOL_NAME`) — duplicated as a literal rather
 *  than imported: that package's `node:child_process`/`node:fs` runtime
 *  code must never reach the web bundle. Its calls are `approval: "ask"`
 *  too, so they need the same in-panel decision `run_shell` calls get. */
const PUBLISH_WORKSPACE_TOOL_NAME = "publish_workspace";
const BUILD_APPROVAL_TOOL_NAMES = new Set([RUN_SHELL_TOOL_NAME, PUBLISH_WORKSPACE_TOOL_NAME]);

/** The mail bodies that start a fresh or continued build attempt — see the
 *  build-engineer's prompt (`kit.ts`) for the `attempts/<n>/` convention
 *  these correspond to. */
const START_ATTEMPT_BODY = "Start the build attempt.";
const CONTINUE_ATTEMPT_BODY = "Continue the build.";

/**
 * The stage 8 build specialist's `publish_workspace` fallback result, when
 * its latest reply carries one: `{fileName, mediaType, dataUri, sizeBytes}`,
 * either as the whole message body or inside a fenced code block. Anything
 * else (a plain status update, or the real-upload result shape which has no
 * `dataUri`) is not a fallback bundle.
 */
export function parsePublishedBundle(
  body: string | undefined,
): { fileName: string; mediaType: string; dataUri: string; sizeBytes: number } | null {
  if (!body) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body)?.[1] ?? body;
  try {
    const parsed = JSON.parse(fenced.trim()) as Record<string, unknown>;
    if (
      typeof parsed["fileName"] === "string" &&
      typeof parsed["mediaType"] === "string" &&
      typeof parsed["dataUri"] === "string" &&
      typeof parsed["sizeBytes"] === "number"
    ) {
      return parsed as { fileName: string; mediaType: string; dataUri: string; sizeBytes: number };
    }
  } catch {
    // Not a bundle — an ordinary chat reply.
  }
  return null;
}

/**
 * Whether the current build attempt has produced evidence to approve
 * against: EITHER a `build_evidence` artifact (`publish_workspace`'s real
 * upload) written no earlier than the last "Start"/"Continue" mail sent to
 * the specialist, OR — on the fallback path, where no artifact exists until
 * `approve()` persists it — the specialist's latest reply already carrying
 * a fallback bundle. Approving with neither would freeze a stage-8 reply
 * that never actually built anything — the bug this stage shipped with, and
 * the reason Approve could never enable at all once the real-upload path
 * shipped (the artifact only ever appeared AFTER approval, behind the
 * disabled button — CL-8723).
 */
export function buildEvidenceState(
  messages: readonly ChatMessage[],
  nodes: readonly ArtifactNode[],
  hasPublishedBundle = false,
): { ready: boolean; reason: string | null } {
  const archive = nodes
    .filter((node) => node.kind === "build_evidence" && node.mediaType === "application/gzip" && node.supersededByNodeId === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const lastAttemptStartedAt = [...messages]
    .filter((message) => message.author === "me" && [START_ATTEMPT_BODY, CONTINUE_ATTEMPT_BODY].includes(message.body.trim()))
    .map((message) => Date.parse(message.at))
    .sort((a, b) => b - a)[0];
  const archiveIsCurrent =
    archive !== undefined && (lastAttemptStartedAt === undefined || Date.parse(archive.createdAt) >= lastAttemptStartedAt);
  if (archiveIsCurrent || hasPublishedBundle) return { ready: true, reason: null };
  if (!archive) {
    return { ready: false, reason: "No published build archive yet — the build has not run publish_workspace." };
  }
  return { ready: false, reason: "The current attempt has not published a build archive yet." };
}

type RunEvent = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

/** `GET /api/tenants/<t>/workflows/runs/<runId>/events`: the run's own
 *  committed, seq-ordered event log (RunStarted, StepStarted, SignalAwaited,
 *  SignalReceived, ...), read straight off the tenant-wide runs route --
 *  the same one workbench's `insightsRunEventsPath` reads. */
async function runEvents(tenantId: string, runId: string): Promise<RunEvent[]> {
  const transport = createHubTransport();
  const page = await transport
    .fetch<{ runId: string; events: RunEvent[] }>("GET", `/api/tenants/${tenantId}/workflows/runs/${runId}/events`)
    .catch(() => ({ runId, events: [] as RunEvent[] }));
  return page.events;
}

/** One row in the build timeline: a tool call, a run milestone, or a reply. */
type TimelineRow = {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone: "info" | "selected" | "success" | "error" | "warning";
};

function approvalRows(approvals: readonly PendingApproval[]): TimelineRow[] {
  return approvals
    .filter((approval) => BUILD_APPROVAL_TOOL_NAMES.has(approval.toolDefinition?.name ?? ""))
    .map((approval) => {
      const isPublish = approval.toolDefinition?.name === PUBLISH_WORKSPACE_TOOL_NAME;
      const command = approval.toolArguments["command"];
      const resolvedAt = approval.resolvedAt ?? null;
      const tone =
        approval.status === "pending" ? "selected" : approval.status === "approved" ? "success" : "error";
      return {
        id: `approval:${approval.id}`,
        at: resolvedAt ?? approval.createdAt,
        label: isPublish
          ? approval.status === "pending"
            ? "asks to publish the build archive"
            : approval.status === "approved"
              ? "published the build archive"
              : `publish ${approval.status}`
          : approval.status === "pending"
            ? "asks to run a command"
            : approval.status === "approved"
              ? "ran a command"
              : `command ${approval.status}`,
        detail: typeof command === "string" ? command : JSON.stringify(approval.toolArguments),
        tone,
      };
    });
}

const RUN_MILESTONE_LABEL: Record<string, string> = {
  RunStarted: "the build specialist started",
  StepStarted: "working",
  SignalReceived: "resumed",
};

function eventRows(events: readonly RunEvent[]): TimelineRow[] {
  return events.flatMap((event): TimelineRow[] => {
    if (event.type === "SignalAwaited") {
      const parkKind = event.body["parkKind"];
      return [
        {
          id: `event:${event.seq}`,
          at: String(event.body["at"] ?? ""),
          label: parkKind === "input" ? "waiting on you" : "waiting for your approval",
          tone: "warning",
        },
      ];
    }
    const label = RUN_MILESTONE_LABEL[event.type];
    if (!label) return [];
    return [{ id: `event:${event.seq}`, at: String(event.body["at"] ?? ""), label, tone: "info" }];
  });
}

function replyRows(messages: readonly ChatMessage[]): TimelineRow[] {
  return messages
    .filter((message) => message.author === "agent")
    .map((message) => ({
      id: `reply:${message.id}`,
      at: message.at,
      label: "reported",
      detail: message.body.length > 140 ? `${message.body.slice(0, 140)}…` : message.body,
      tone: "success" as const,
    }));
}

/**
 * The current state, in the same vocabulary the old bridge's `StateLabel`
 * used: waiting on a decision beats everything else, then whether the run's
 * last milestone is still open, then idle.
 */
function currentState(
  approvals: readonly PendingApproval[],
  events: readonly RunEvent[],
  messages: readonly ChatMessage[],
): { label: string; tone: "warning" | "selected" | "success" | "info" } {
  const pending = approvals.find(
    (approval) => approval.status === "pending" && BUILD_APPROVAL_TOOL_NAMES.has(approval.toolDefinition?.name ?? ""),
  );
  if (pending) return { label: "waiting for your approval", tone: "warning" };

  const lastReplyAt = messages.filter((message) => message.author === "agent").at(-1)?.at;
  const lastEvent = [...events].reverse().find((event) => ["StepStarted", "SignalReceived"].includes(event.type));
  if (lastEvent) {
    const lastEventAt = String(lastEvent.body["at"] ?? "");
    if (!lastReplyAt || Date.parse(lastReplyAt) < Date.parse(lastEventAt)) return { label: "working", tone: "selected" };
  }
  if (lastReplyAt) return { label: "reported · your decision", tone: "success" };
  return { label: "idle", tone: "info" };
}

/** When the build attempt began, for the elapsed clock: the earliest
 *  `RunStarted` this run has committed, or null before one has. */
function startedAt(events: readonly RunEvent[]): string | null {
  const started = events.find((event) => event.type === "RunStarted");
  return started ? String(started.body["at"] ?? "") || null : null;
}

/** Counts up from `since`, or shows nothing until there is one. */
function BuildClock({ since }: { since: string | null }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!since) return;
    const started = Date.parse(since);
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  return (
    <p className="elapsed">
      <span className="elapsed-clock" role="timer" aria-live="off">
        {clock(seconds)}
      </span>{" "}
      elapsed since the build attempt started.
    </p>
  );
}

export function BuildPanel({
  detail,
  tenantId,
  onChanged,
  onOpenSettings,
  onApprove,
  approving,
  canApprove,
  onOpenDecisions,
}: {
  detail: ProjectDetail;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  onChanged: () => void;
  onOpenSettings: () => void;
  onApprove: () => void;
  approving: boolean;
  canApprove: boolean;
  /** Where "waiting for your approval" sends the person. */
  onOpenDecisions?: () => void;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .ensureStageAgent(detail.project.id, 8)
      .then((deployment) => {
        if (cancelled) return;
        setAddress(deployment.address);
        setRunId(deployment.deploymentId);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [detail.project.id]);

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

  // Refreshes the project detail (and so `detail.nodes`) whenever this
  // stage's thread grows — the only signal this panel has that
  // `publish_workspace` may have just uploaded a real `build_evidence`
  // artifact, which nothing else here polls for (CL-8723).
  const lastMessageCount = useRef(0);
  useEffect(() => {
    if (messages.length > lastMessageCount.current) onChanged();
    lastMessageCount.current = messages.length;
  }, [messages, onChanged]);

  // The timeline: hub approvals and the run's own event log, folded
  // together every 5s -- the same cadence the old bridge's event log
  // polled at.
  const loadTimeline = useCallback(async () => {
    if (!runId) return;
    const transport = createHubTransport();
    const [nextApprovals, nextEvents] = await Promise.all([
      pendingApprovals(tenantId, transport).catch(() => [] as readonly PendingApproval[]),
      runEvents(tenantId, runId),
    ]);
    setApprovals(nextApprovals.filter((approval) => approval.runId === runId).slice());
    setEvents(nextEvents);
  }, [runId, tenantId]);

  useEffect(() => {
    if (!runId) return;
    void loadTimeline();
    const timer = setInterval(() => void loadTimeline(), 5_000);
    return () => clearInterval(timer);
  }, [runId, loadTimeline]);

  const send = async (label: string, body: string) => {
    if (!address) return;
    setBusy(label);
    setError(null);
    try {
      await api.sendStageMail(tenantId, address, { body });
      await Promise.all([load(), loadTimeline()]);
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const timeline = useMemo(
    () =>
      [...approvalRows(approvals), ...eventRows(events), ...replyRows(messages)]
        .filter((row) => row.at)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [approvals, events, messages],
  );
  const state = useMemo(() => currentState(approvals, events, messages), [approvals, events, messages]);
  const buildStartedAt = useMemo(() => startedAt(events), [events]);

  const build = useMemo(
    () =>
      detail.nodes
        .filter((node) => node.kind === "build_evidence" && node.mediaType === "application/gzip" && node.supersededByNodeId === null)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0],
    [detail.nodes],
  ) as ArtifactNode | undefined;

  const publishedBundle = useMemo(
    () => parsePublishedBundle([...messages].reverse().find((message) => message.author === "agent")?.body),
    [messages],
  );
  const evidence = useMemo(
    () => buildEvidenceState(messages, detail.nodes, publishedBundle !== null),
    [messages, detail.nodes, publishedBundle],
  );

  const pendingRunShell = approvals.filter(
    (approval) => approval.status === "pending" && BUILD_APPROVAL_TOOL_NAMES.has(approval.toolDefinition?.name ?? ""),
  );
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const decideRunShell = async (approvalId: string, decision: "once" | "always" | "reject") => {
    setDecidingId(approvalId);
    setError(null);
    try {
      if (decision === "reject") {
        await rejectTool(tenantId, approvalId, "Rejected from the build panel.");
      } else {
        await approveTool(tenantId, approvalId, decision);
      }
      await loadTimeline();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <div data-tour="build-panel">
      <Screen
        title="Build supervision"
        status={
          address ? (
            <StateLabel tone={state.tone}>
              {state.label === "waiting for your approval" && onOpenDecisions ? (
                <Button variant="link" onClick={onOpenDecisions}>
                  {state.label}
                </Button>
              ) : (
                state.label
              )}
            </StateLabel>
          ) : null
        }
      >
        {error ? (
          <Banner tone="error" title="The build attempt could not be changed" action={{ label: "Open Settings", onClick: onOpenSettings }}>
            {error}
          </Banner>
        ) : null}
        {!address ? <p className="inline-note">Starting the build specialist…</p> : null}
        <BuildClock since={buildStartedAt} />
        <div className="button-row">
          <Button variant="primary" loading={busy === "start"} disabled={!address} onClick={() => void send("start", START_ATTEMPT_BODY)}>
            Start the build attempt
          </Button>
          <Button variant="primary" loading={busy === "continue"} disabled={!address} onClick={() => void send("continue", CONTINUE_ATTEMPT_BODY)}>
            Continue from the last attempt
          </Button>
          <Button variant="destructive" loading={busy === "cancel"} disabled={!address} onClick={() => void send("cancel", "Cancel the build attempt.")}>
            Cancel the build attempt
          </Button>
          <Button variant="primary" loading={busy === "accept"} disabled={!address} onClick={() => void send("accept", "Accept this build attempt's work as evidence.")}>
            Accept as evidence
          </Button>
          <Button variant="destructive" loading={busy === "fail"} disabled={!address} onClick={() => void send("fail", "Mark this build attempt failed.")}>
            Mark this attempt failed
          </Button>
          <Button variant="primary" loading={approving} disabled={!canApprove || !address} onClick={onApprove}>
            Approve and continue
          </Button>
        </div>
        <p className="inline-note">
          {canApprove ? "Approving records the published build archive as this stage's evidence and starts delivery." : evidence.reason}
        </p>

        {pendingRunShell.length > 0 ? (
          <div className="stage-companions" aria-label="Pending build approvals">
            {pendingRunShell.map((approval) => (
              <div key={approval.id} className="field">
                <p>
                  Asks to run: <code className="hash">{typeof approval.toolArguments["command"] === "string" ? (approval.toolArguments["command"] as string) : JSON.stringify(approval.toolArguments)}</code>
                </p>
                <p className="inline-note">
                  "Allow for this build" trusts every future <code>run_shell</code> call on this build attempt,
                  without asking again — not another tool, another attempt, or another project.
                </p>
                <div className="button-row">
                  <Button variant="primary" loading={decidingId === approval.id} onClick={() => void decideRunShell(approval.id, "once")}>
                    Allow once
                  </Button>
                  <Button loading={decidingId === approval.id} onClick={() => void decideRunShell(approval.id, "always")}>
                    Allow for this build
                  </Button>
                  <Button variant="destructive" loading={decidingId === approval.id} onClick={() => void decideRunShell(approval.id, "reject")}>
                    Reject…
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {build ? <BuildFile node={build} tenantId={tenantId} /> : null}

        {timeline.length > 0 ? (
          <dl className="version-list">
            {timeline.map((row) => (
              <div key={row.id}>
                <dt>
                  <StateLabel tone={row.tone}>{row.label}</StateLabel> ·{" "}
                  {new Date(row.at).toLocaleString()}
                </dt>
                {row.detail ? <dd className="hash">{row.detail}</dd> : null}
              </div>
            ))}
          </dl>
        ) : (
          <p className="inline-note">No build activity has reported yet.</p>
        )}
      </Screen>
      <StageConversation
        stage={8}
        messages={messages}
        value={composer}
        onValueChange={setComposer}
        onSend={() => {
          const body = composer;
          setComposer("");
          void send("message", body);
        }}
        working={busy !== null}
        disabled={!address}
      />
    </div>
  );
}
