/**
 * Stage 9's inline decision, as the document pane.
 *
 * Approving delivery is a stock hub approval on the specialist's `deliver`
 * tool call (CL-8566), not a lifecycle gate, so this reads the pending
 * approval straight off the workspace tenant the same way the Decision queue
 * does (`../../decisions-fold.ts`) and resolves it with the same
 * `approveTool`/`rejectTool` helpers — but inline, on the project's own
 * stage, instead of making the person leave for the queue.
 */
import { useRef, useState, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Textarea } from "@corbits/react-ui";
import { keys } from "../../queries/keys.ts";
import { listSpecialistDeployments } from "@solutions-builder/installer";
import { agentFor } from "@solutions-builder/app/kit";
import { api, ApiFailure, type ArtifactNode, type ProjectDetail } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { createHubTransport } from "../../hub.ts";
import {
  approvalById,
  approveTool,
  deliveryApprovalFor,
  pendingApprovals,
  rejectTool,
  type PendingApproval,
} from "../../pending-approvals.ts";
import { parseDeliveryVerification, type DeliveryVerification } from "../../delivery-verification.ts";
import { manifestCompanionOf } from "./stage9-opening.ts";
import { Banner, Button, CopyButton, documentName, shortHash } from "../../components.jsx";
import { formatSize } from "../graph.jsx";
import { Markdown } from "../../markdown.jsx";
import { ApproveControl } from "./approve-control.tsx";

/** Same cadence `BuildPanel` polls its own pending approvals at — a manifest
 *  awaiting review must refresh on its own, not just once at mount. */
const POLL_INTERVAL_MS = 5_000;

/** The heading the delivery specialist writes for its run instructions, wherever it lands in the reply. */
const HOW_TO_RUN_HEADING = /^#{1,3}\s*(repo(?:\s+and)?\s+how\s+to\s+run\s+it|how\s+to\s+run(?:\s+it)?)\s*$/im;

const VERIFIER = agentFor(9).title;

/** Pulls the "how to run it" section out of the specialist's own reply so it leads the panel instead of sitting buried in prose. */
export function extractHowToRun(body: string | null): string | null {
  if (!body) return null;
  const match = HOW_TO_RUN_HEADING.exec(body);
  if (!match) return null;
  const rest = body.slice(match.index + match[0].length);
  const nextHeading = rest.search(/^#{1,3}\s+\S/m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return `${match[0]}\n${section}`.trim();
}

/** The node that carries the per-file check results: the delivery manifest
 *  `publish_workspace` wrote beside the approved stage 8 archive, whose
 *  embedded `verification` is what the tool itself established (#129); or,
 *  failing that, a stage 9 `delivery_verification` record or manifest. */
export function findVerificationNode(nodes: ArtifactNode[], archiveRef: { artifactId: string; version: number } | null): ArtifactNode | null {
  const archive = archiveRef ? (nodes.find((node) => node.artifactId === archiveRef.artifactId && node.version === archiveRef.version) ?? null) : null;
  const companion = archive ? manifestCompanionOf(nodes, archive) : null;
  if (companion) return companion;
  const active = nodes.filter((node) => node.stage === 9 && node.supersededByNodeId === null);
  return (
    active.find((node) => node.kind === "delivery_verification") ??
    active.find((node) => node.kind === "delivery_manifest") ??
    null
  );
}

function checklistClass(status: DeliveryVerification["rows"][number]["status"]): string {
  if (status === "passed") return "ok";
  if (status === "failed") return "fail";
  return "open";
}

/** The compact per-file checklist above Accept/Reject, plus the warning line failures earn. */
function VerificationList({ verification }: { verification: DeliveryVerification }) {
  const { rows, summary, problems } = verification;
  if (rows.length === 0) {
    return <p className="inline-note">{problems.length > 0 ? "Verification could not be read" : "Nothing was verified"}</p>;
  }
  return (
    <>
      {summary.failed > 0 ? (
        <p className="warning-note">
          {summary.failed} check{summary.failed === 1 ? "" : "s"} failed
        </p>
      ) : summary.passed === 0 ? (
        <p className="inline-note">Nothing was verified</p>
      ) : null}
      {/* Folded unless something failed: a clean list of every file is
          there to check, not to read. */}
      <details className="delivery-files" open={summary.failed > 0}>
        <summary>
          {summary.passed} of {rows.length} file{rows.length === 1 ? "" : "s"} verified
        </summary>
        <ul className="checklist">
          {rows.map((row) => (
            <li key={row.path} className={checklistClass(row.status)}>
              {row.path}
              {row.note ? ` — ${row.note}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/** One delivered file: its size, and its hash shortened, whole on hover and when copied. */
function ArtifactRow({ artifact }: { artifact: Record<string, unknown> }) {
  const hash = typeof artifact["contentHash"] === "string" ? (artifact["contentHash"] as string) : null;
  const size = typeof artifact["sizeBytes"] === "number" ? formatSize(artifact["sizeBytes"]) : null;
  return (
    <div className="cost-row">
      <span>{typeof artifact["path"] === "string" ? artifact["path"] : "—"}</span>
      <span>
        {size}
        {size && hash ? " · " : null}
        {hash ? (
          <>
            <code className="delivery-hash" title={hash}>
              {shortHash(hash)}
            </code>
            <CopyButton text={hash} label="Copy hash" />
          </>
        ) : null}
        {!size && !hash ? "—" : null}
      </span>
    </div>
  );
}

/** Stage 9's manifest, awaiting a decision. */
function DeliveryDecision({
  tenantId,
  projectId,
  nodes,
  archiveRef,
  howToRun,
  finished,
  onAccept,
  onRejectSendBack,
  panes,
}: {
  tenantId: string;
  projectId: string;
  nodes: ArtifactNode[];
  /** Stage 8's approved archive, off the workflow's own review record. */
  archiveRef: { artifactId: string; version: number } | null;
  howToRun: string | null;
  /** The workflow has recorded stage 9's approval: the project is delivered. */
  finished: boolean;
  /**
   * Called after the hub's `deliver` tool approval succeeds, to also send
   * the project workflow its stage 9 `approve` decision — the tool approval
   * alone never advanced the workflow, so the project never finished
   * (CL-8723 follow-up). Throwing (or the returned promise rejecting) is
   * surfaced the same way a `decide` failure elsewhere in this panel is.
   */
  onAccept: () => Promise<void>;
  /** Rejecting delivery also routes the project workflow back to stage 8
   *  (CL-8687), so the build specialist's next reply lands where the person
   *  can review and re-approve it rather than leaving stage 9 stuck. */
  onRejectSendBack: () => void;
  /** Lays the delivery out beside the conversation, with the approve row under its composer. */
  panes: (row: ReactNode, pane: ReactNode) => ReactNode;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The last pending approval id seen this session, so a resolved delivery
  // can still be looked up by id once it drops off the pending list. Held in
  // memory only — a reload before this fires just loses the "Delivered"
  // banner until the next delivery, never the delivery itself.
  const lastSeenApprovalId = useRef<string | null>(null);
  // The tenant the stage 9 specialist's approval is parked in: the
  // project's own, or the workspace for a specialist deployed before #29.
  // Learned from the deployment on each load, never assumed.
  const approvalTenant = useRef(tenantId);

  // Polls while a decision is pending, the same cadence every other panel's
  // pending-approval poll uses — a manifest that only loaded once at mount
  // never told anyone it had arrived (defect: an empty pane until reload).
  // Stops once delivered: there is nothing left to poll for.
  const query = useQuery({
    queryKey: keys.approvals.delivery(tenantId, projectId),
    queryFn: async (): Promise<{ pending: PendingApproval | null; delivered: PendingApproval | null }> => {
      const transport = createHubTransport();
      const deployments = await listSpecialistDeployments(transport, projectId);
      const stage9 = deployments.find((deployment) => deployment.stage === 9);
      approvalTenant.current = stage9?.tenantId ?? tenantId;
      const approvals = await pendingApprovals(approvalTenant.current, transport);
      // Matched on the deployment's anchor identity, not a nested tool run's
      // own `runId` — see `pending-approvals.ts`'s `deliveryApprovalFor`.
      const found = stage9 ? deliveryApprovalFor(approvals, stage9.deploymentId) : null;
      if (found) {
        lastSeenApprovalId.current = found.id;
        return { pending: found, delivered: null };
      }
      const resolved = lastSeenApprovalId.current ? await approvalById(approvalTenant.current, lastSeenApprovalId.current, transport) : null;
      return { pending: null, delivered: resolved?.status === "approved" ? resolved : null };
    },
    refetchInterval: (current) => (finished || current.state.data?.delivered ? false : POLL_INTERVAL_MS),
  });
  const pending = query.data?.pending ?? null;
  const delivered = query.data?.delivered ?? null;
  const loaded = !query.isPending;
  const loadError = query.error ? (query.error instanceof ApiFailure ? query.error.detail.message : String(query.error)) : null;
  const load = query.refetch;

  const verificationNode = findVerificationNode(nodes, archiveRef);
  const verificationRead = useQuery({
    queryKey: keys.artifact.of(tenantId, verificationNode?.id ?? ""),
    queryFn: verificationNode ? async () => (await api.artifactContent(tenantId, verificationNode.id)).content : skipToken,
    select: (content) => parseDeliveryVerification(JSON.parse(content)),
    staleTime: Infinity,
  });
  const verification = verificationNode ? (verificationRead.data ?? null) : parseDeliveryVerification(null);
  const verificationError = verificationRead.error ? `The verification record could not be read: ${verificationRead.error.message}` : null;
  const shownError = error ?? loadError ?? verificationError;

  if (!loaded) return panes(null, null);

  const summary = pending && typeof pending.toolArguments["summary"] === "string" ? (pending.toolArguments["summary"] as string) : null;
  const artifacts =
    pending && Array.isArray(pending.toolArguments["artifacts"])
      ? (pending.toolArguments["artifacts"] as Array<Record<string, unknown>>)
      : [];

  const decide = async (decision: "approve" | "reject") => {
    if (!pending) return;
    setBusy(decision);
    setError(null);
    try {
      if (decision === "approve") {
        await approveTool(approvalTenant.current, pending.id);
        try {
          await onAccept();
        } catch (cause) {
          setError(
            `The delivery was accepted, but the project could not be marked finished: ${
              cause instanceof ApiFailure ? cause.detail.message : String(cause)
            }`,
          );
        }
      } else {
        await rejectTool(approvalTenant.current, pending.id, feedback);
        setFeedback("");
        onRejectSendBack();
      }
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const isDelivered = delivered !== null || finished;
  const deliveredAt = delivered?.resolvedAt ? ` ${new Date(delivered.resolvedAt).toLocaleString()}` : "";
  const meta = isDelivered
    ? `Final · ${VERIFIER} · delivered${deliveredAt}`
    : pending
      ? `Draft · ${VERIFIER} · awaiting review`
      : VERIFIER;

  return panes(
    isDelivered ? null : (
      <ApproveControl
        waiting={pending ? null : `Waiting on ${VERIFIER} to submit a delivery for review.`}
        busy={busy === "approve"}
        onApprove={() => void decide("approve")}
      />
    ),
    <div className="doc" data-tour="document-body">
      <h1>{documentName("delivery_manifest")}</h1>
      <p className="docmeta">{meta}</p>
      {shownError ? <Banner tone="error" title={shownError} /> : null}
      {isDelivered ? (
        <p className="delivery-done" role="status">
          Delivered. The project is finished. Each file handed over is recorded with a fingerprint, so what you received can be checked against it.
        </p>
      ) : null}
      {howToRun ? (
        <section className="delivery-how-to-run">
          <Markdown source={howToRun} />
        </section>
      ) : null}
      {summary ? <p>{summary}</p> : null}
      {artifacts.length > 0 ? (
        <details className="delivery-files">
          <summary>
            {artifacts.length} file{artifacts.length === 1 ? "" : "s"} in this delivery
          </summary>
          {artifacts.map((artifact, index) => (
            <ArtifactRow key={index} artifact={artifact} />
          ))}
        </details>
      ) : null}
      {verification ? (
        <>
          <h2>{documentName("delivery_verification")}</h2>
          <VerificationList verification={verification} />
        </>
      ) : null}
      {pending ? (
        <>
          <h2>Sign-off</h2>
          <div className="field">
            <label htmlFor="delivery-feedback">Feedback</label>
            <Textarea
              id="delivery-feedback"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What's missing or wrong."
            />
          </div>
          <div className="button-row">
            <Button loading={busy === "reject"} onClick={() => void decide("reject")}>
              Reject
            </Button>
          </div>
        </>
      ) : null}
    </div>,
  );
}

export function DeliveryPanel({
  detail,
  tenantId,
  archiveRef,
  latestReply,
  finished,
  onAccept,
  onRejectSendBack,
  panes,
}: {
  detail: ProjectDetail;
  tenantId: string;
  /** Stage 8's approved archive, off the workflow's own review record. */
  archiveRef: { artifactId: string; version: number } | null;
  latestReply: ChatMessage | null;
  /** The workflow has recorded stage 9's approval. */
  finished: boolean;
  /** Called once the hub's `deliver` tool approval succeeds, to also send
   *  the project workflow its stage 9 `approve` decision. */
  onAccept: () => Promise<void>;
  /** Called once a delivery rejection has been recorded on the hub, so the
   *  caller can route the project workflow back to stage 8. */
  onRejectSendBack: () => void;
  /** Lays the delivery out beside the conversation, with the approve row under its composer. */
  panes: (row: ReactNode, pane: ReactNode) => ReactNode;
}) {
  return (
    <DeliveryDecision
      tenantId={tenantId}
      projectId={detail.project.id}
      nodes={detail.nodes}
      archiveRef={archiveRef}
      howToRun={extractHowToRun(latestReply?.body ?? null)}
      finished={finished}
      onAccept={onAccept}
      onRejectSendBack={onRejectSendBack}
      panes={panes}
    />
  );
}
