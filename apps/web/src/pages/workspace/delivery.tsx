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
import { useEffect, useRef, useState } from "react";
import { Textarea } from "@corbits/react-ui";
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
import { Banner, Button, documentName, shortHash } from "../../components.jsx";
import { Markdown } from "../../markdown.jsx";

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

/** The node that carries stage 9's per-file check results, newest first: a
 *  dedicated `delivery_verification` record, or the manifest's own embedded
 *  `verification` field. */
export function findVerificationNode(nodes: ArtifactNode[]): ArtifactNode | null {
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
      <ul className="checklist">
        {rows.map((row) => (
          <li key={row.path} className={checklistClass(row.status)}>
            {row.path}
            {row.note ? ` — ${row.note}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

function artifactMeta(artifact: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof artifact["sizeBytes"] === "number") {
    const bytes = artifact["sizeBytes"] as number;
    parts.push(bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`);
  }
  if (typeof artifact["contentHash"] === "string") parts.push(shortHash(artifact["contentHash"]));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Stage 9's manifest, awaiting a decision. */
function DeliveryDecision({
  tenantId,
  projectId,
  nodes,
  howToRun,
  onAccept,
  onRejectSendBack,
}: {
  tenantId: string;
  projectId: string;
  nodes: ArtifactNode[];
  howToRun: string | null;
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
}) {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [delivered, setDelivered] = useState<PendingApproval | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The last pending approval id seen this session, so a resolved delivery
  // can still be looked up by id once it drops off the pending list. Held in
  // memory only — a reload before this fires just loses the "Delivered"
  // banner until the next delivery, never the delivery itself.
  const [lastSeenApprovalId, setLastSeenApprovalId] = useState<string | null>(null);

  // A stale in-flight poll must never overwrite what a later call (Accept's
  // own `load()`, or a newer tick) already found — same shape as the
  // verification effect below's `cancelled` guard, but as a sequence number
  // since `load` can be in flight more than once concurrently.
  const requestSeq = useRef(0);
  // Mirrors `delivered` for the interval's closure — once the manifest is
  // delivered there is nothing left to poll for.
  const deliveredRef = useRef(false);

  const load = async () => {
    if (deliveredRef.current) return;
    const seq = ++requestSeq.current;
    const transport = createHubTransport();
    try {
      const [approvals, deployments] = await Promise.all([
        pendingApprovals(tenantId, transport),
        listSpecialistDeployments(transport, tenantId, projectId),
      ]);
      if (seq !== requestSeq.current) return;
      const stage9 = deployments.find((deployment) => deployment.stage === 9);
      // Matched on the deployment's anchor identity, not a nested tool run's
      // own `runId` — see `pending-approvals.ts`'s `deliveryApprovalFor`.
      const found = stage9 ? deliveryApprovalFor(approvals, stage9.deploymentId) : null;
      if (found) {
        setLastSeenApprovalId(found.id);
        setPending(found);
        setDelivered(null);
        setLoaded(true);
        return;
      }
      setPending(null);
      if (lastSeenApprovalId) {
        const resolved = await approvalById(tenantId, lastSeenApprovalId, transport).catch(() => null);
        if (seq !== requestSeq.current) return;
        const isDelivered = resolved !== null && resolved.status === "approved";
        setDelivered(isDelivered ? resolved : null);
        deliveredRef.current = isDelivered;
      }
    } catch (cause) {
      if (seq === requestSeq.current) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  };

  // Polls while a decision is pending, the same cadence every other panel's
  // pending-approval poll uses — a manifest that only loaded once at mount
  // never told anyone it had arrived (defect: an empty pane until reload).
  // Stops once delivered — `load` itself also short-circuits, but skipping
  // the call here means a pending timer never has to make the round trip.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!deliveredRef.current) void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId]);

  const verificationNode = findVerificationNode(nodes);
  const [verification, setVerification] = useState<DeliveryVerification | null>(null);

  useEffect(() => {
    if (!verificationNode) {
      setVerification(parseDeliveryVerification(null));
      return;
    }
    let cancelled = false;
    void api
      .artifactContent(tenantId, verificationNode.id)
      .then((result) => {
        if (cancelled) return;
        try {
          setVerification(parseDeliveryVerification(JSON.parse(result.content)));
        } catch {
          setVerification(parseDeliveryVerification(undefined));
        }
      })
      .catch(() => {
        if (!cancelled) setVerification(parseDeliveryVerification(undefined));
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, verificationNode?.id]);

  if (!loaded) return null;

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
        await approveTool(tenantId, pending.id);
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
        await rejectTool(tenantId, pending.id, feedback);
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

  const deliveredAt = delivered?.resolvedAt ? new Date(delivered.resolvedAt).toLocaleString() : "just now";
  const meta = delivered
    ? `Final · ${VERIFIER} · delivered ${deliveredAt}`
    : pending
      ? `Draft · ${VERIFIER} · awaiting review`
      : VERIFIER;

  return (
    <div className="doc" data-tour="document-body">
      <h1>{documentName("delivery_manifest")}</h1>
      <p className="docmeta">{meta}</p>
      {error ? <Banner tone="error" title={error} /> : null}
      {!pending && !delivered ? <p className="inline-note">Waiting on {VERIFIER} to submit a delivery for review.</p> : null}
      {summary ? <p>{summary}</p> : null}
      {artifacts.length > 0 ? (
        artifacts.map((artifact, index) => (
          <div className="cost-row" key={index}>
            <span>{typeof artifact["path"] === "string" ? artifact["path"] : "—"}</span>
            <span>{artifactMeta(artifact)}</span>
          </div>
        ))
      ) : null}
      {verification ? (
        <>
          <h2>{documentName("delivery_verification")}</h2>
          <VerificationList verification={verification} />
        </>
      ) : null}
      {howToRun ? <Markdown source={howToRun} /> : null}
      {delivered ? (
        <>
          <h2>Sign-off</h2>
          <p>Delivered. The manifest names exact versions and hashes.</p>
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
            <Button variant="primary" loading={busy === "approve"} onClick={() => void decide("approve")}>
              Accept
            </Button>
            <Button loading={busy === "reject"} onClick={() => void decide("reject")}>
              Reject
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function DeliveryPanel({
  detail,
  tenantId,
  latestReply,
  onAccept,
  onRejectSendBack,
}: {
  detail: ProjectDetail;
  tenantId: string;
  latestReply: ChatMessage | null;
  /** Called once the hub's `deliver` tool approval succeeds, to also send
   *  the project workflow its stage 9 `approve` decision. */
  onAccept: () => Promise<void>;
  /** Called once a delivery rejection has been recorded on the hub, so the
   *  caller can route the project workflow back to stage 8. */
  onRejectSendBack: () => void;
}) {
  return (
    <DeliveryDecision
      tenantId={tenantId}
      projectId={detail.project.id}
      nodes={detail.nodes}
      howToRun={extractHowToRun(latestReply?.body ?? null)}
      onAccept={onAccept}
      onRejectSendBack={onRejectSendBack}
    />
  );
}
