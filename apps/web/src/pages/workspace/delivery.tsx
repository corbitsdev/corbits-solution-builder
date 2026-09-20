/**
 * Stage 9's inline decision.
 *
 * Approving delivery is a stock hub approval on the specialist's `deliver`
 * tool call (CL-8566), not a lifecycle gate, so this reads the pending
 * approval straight off the workspace tenant the same way the Decision queue
 * does (`../../decisions-fold.ts`) and resolves it with the same
 * `approveTool`/`rejectTool` helpers — but inline, on the project's own
 * stage, instead of making the person leave for the queue.
 */
import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@corbits/react-ui";
import { listSpecialistDeployments } from "@solutions-builder/installer";
import { api, ApiFailure, type ArtifactNode, type ProjectDetail } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { createHubTransport } from "../../hub.ts";
import {
  approvalById,
  approveTool,
  DELIVER_TOOL_NAME,
  pendingApprovals,
  rejectTool,
  type PendingApproval,
} from "../../pending-approvals.ts";
import { parseDeliveryVerification, type DeliveryVerification } from "../../delivery-verification.ts";
import { Banner, Button, Screen, shortHash, StateLabel } from "../../components.jsx";
import { Markdown } from "../../markdown.jsx";
import { BuildFile } from "../graph.jsx";

/** The heading the delivery specialist writes for its run instructions, wherever it lands in the reply. */
const HOW_TO_RUN_HEADING = /^#{1,3}\s*(repo(?:\s+and)?\s+how\s+to\s+run\s+it|how\s+to\s+run(?:\s+it)?)\s*$/im;

/** Pulls the "how to run it" section out of the specialist's own reply so it leads the panel instead of sitting buried in prose. */
function extractHowToRun(body: string | null): string | null {
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
function findVerificationNode(nodes: ArtifactNode[]): ArtifactNode | null {
  const active = nodes.filter((node) => node.stage === 9 && node.supersededByNodeId === null);
  return (
    active.find((node) => node.kind === "delivery_verification") ??
    active.find((node) => node.kind === "delivery_manifest") ??
    null
  );
}

/** The compact per-file table above Accept/Reject, plus the warning line failures earn. */
function VerificationTable({ verification }: { verification: DeliveryVerification }) {
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>File</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.path}>
              <TableCell>{row.path}</TableCell>
              <TableCell>
                <StateLabel tone={row.status === "passed" ? "success" : row.status === "failed" ? "error" : "info"}>
                  {row.status}
                </StateLabel>
              </TableCell>
              <TableCell>{row.note ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

/** Stage 9's manifest, awaiting a decision. */
function DeliveryDecision({
  tenantId,
  projectId,
  nodes,
  onAccept,
  onRejectSendBack,
}: {
  tenantId: string;
  projectId: string;
  nodes: ArtifactNode[];
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

  const load = async () => {
    const transport = createHubTransport();
    try {
      const [approvals, deployments] = await Promise.all([
        pendingApprovals(tenantId, transport),
        listSpecialistDeployments(transport, tenantId, projectId),
      ]);
      const stage9 = deployments.find((deployment) => deployment.stage === 9);
      const found = stage9
        ? approvals.find(
            (approval) =>
              approval.status === "pending" &&
              approval.runId === stage9.deploymentId &&
              approval.toolDefinition?.name === DELIVER_TOOL_NAME,
          )
        : undefined;
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
        setDelivered(resolved && resolved.status === "approved" ? resolved : null);
      }
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
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

  if (delivered) {
    return (
      <Screen title="Delivery" tight>
        <StateLabel tone="success">
          Delivered · {delivered.resolvedAt ? new Date(delivered.resolvedAt).toLocaleString() : "just now"}
        </StateLabel>
      </Screen>
    );
  }

  if (!pending) return null;

  const summary = typeof pending.toolArguments["summary"] === "string" ? (pending.toolArguments["summary"] as string) : null;
  const artifacts = Array.isArray(pending.toolArguments["artifacts"])
    ? (pending.toolArguments["artifacts"] as Array<Record<string, unknown>>)
    : [];
  const manifestNodeId =
    typeof pending.toolArguments["manifestNodeId"] === "string" ? (pending.toolArguments["manifestNodeId"] as string) : null;

  const decide = async (decision: "approve" | "reject") => {
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

  return (
    <Screen title="Delivery awaits a decision" tight priority>
      {error ? <Banner tone="error" title={error} /> : null}
      {summary ? <p>{summary}</p> : null}
      {manifestNodeId ? <p className="inline-note">Manifest {shortHash(manifestNodeId)}</p> : null}
      {artifacts.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Content hash</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact, index) => (
              <TableRow key={index}>
                <TableCell>{typeof artifact["path"] === "string" ? artifact["path"] : "—"}</TableCell>
                <TableCell className="hash">
                  {typeof artifact["contentHash"] === "string" ? shortHash(artifact["contentHash"]) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {verification ? <VerificationTable verification={verification} /> : null}
      <div className="field">
        <label htmlFor="delivery-feedback">Feedback (only sent on reject)</label>
        <Textarea
          id="delivery-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="What's missing or wrong, so the specialist can fix it and try again."
        />
      </div>
      <div className="action-row">
        <Button variant="primary" loading={busy === "approve"} onClick={() => void decide("approve")}>
          Accept the delivery
        </Button>
        <Button loading={busy === "reject"} onClick={() => void decide("reject")}>
          Reject with feedback
        </Button>
      </div>
    </Screen>
  );
}

/** Stage 8's build evidence: the source-of-record for what was actually built. */
function WhatWasBuilt({ node, tenantId }: { node: ArtifactNode; tenantId: string }) {
  const isText = (node.mediaType ?? "").startsWith("text/");
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    void api
      .artifactContent(tenantId, node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [isText, node.id, tenantId]);

  return (
    <Screen title="What was built" tight>
      {isText ? (
        <details>
          <summary>{node.title}</summary>
          <div className="document-body">{content === null ? <p className="inline-note">Loading…</p> : <Markdown source={content} />}</div>
        </details>
      ) : (
        <BuildFile node={node} tenantId={tenantId} />
      )}
    </Screen>
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
  const buildEvidence = detail.nodes.filter(
    (node) => node.stage === 8 && node.kind === "build_evidence" && node.supersededByNodeId === null,
  );
  const howToRun = extractHowToRun(latestReply?.body ?? null);

  return (
    <div className="stage-companions">
      <DeliveryDecision
        tenantId={tenantId}
        projectId={detail.project.id}
        nodes={detail.nodes}
        onAccept={onAccept}
        onRejectSendBack={onRejectSendBack}
      />
      {howToRun ? (
        <Screen title="How to run" tight>
          <Markdown source={howToRun} />
        </Screen>
      ) : null}
      {buildEvidence.map((node) => (
        <WhatWasBuilt key={node.id} node={node} tenantId={tenantId} />
      ))}
    </div>
  );
}
