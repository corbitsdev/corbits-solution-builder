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
import { Banner, Button, Screen, shortHash, StateLabel } from "../../components.jsx";
import { Markdown } from "../../markdown.jsx";
import { BuildFile } from "../graph.jsx";

const CACHE_PREFIX = "sb.delivery-approval:";

function cacheKey(projectId: string): string {
  return `${CACHE_PREFIX}${projectId}`;
}

/** Best-effort convenience only: losing this never blocks the decision, it just loses the "Delivered" banner across a reload. */
function readCachedApprovalId(projectId: string): string | null {
  try {
    return localStorage.getItem(cacheKey(projectId));
  } catch {
    return null;
  }
}

function writeCachedApprovalId(projectId: string, approvalId: string): void {
  try {
    localStorage.setItem(cacheKey(projectId), approvalId);
  } catch {
    // ignored — see readCachedApprovalId
  }
}

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

/** Stage 9's manifest, awaiting a decision. */
function DeliveryDecision({ tenantId, projectId }: { tenantId: string; projectId: string }) {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [delivered, setDelivered] = useState<PendingApproval | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);

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
        writeCachedApprovalId(projectId, found.id);
        setPending(found);
        setDelivered(null);
        setLoaded(true);
        return;
      }
      setPending(null);
      const cachedId = readCachedApprovalId(projectId);
      if (cachedId) {
        const resolved = await approvalById(tenantId, cachedId, transport).catch(() => null);
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
      } else {
        await rejectTool(tenantId, pending.id, feedback);
        setFeedback("");
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
}: {
  detail: ProjectDetail;
  tenantId: string;
  latestReply: ChatMessage | null;
}) {
  const buildEvidence = detail.nodes.filter(
    (node) => node.stage === 8 && node.kind === "build_evidence" && node.supersededByNodeId === null,
  );
  const howToRun = extractHowToRun(latestReply?.body ?? null);

  return (
    <div className="stage-companions">
      <DeliveryDecision tenantId={tenantId} projectId={detail.project.id} />
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
