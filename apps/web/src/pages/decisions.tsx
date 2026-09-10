/**
 * The Decision Queue — the surface the product leads with.
 *
 * Structure follows the design mockup rather than a list of equal rows: one
 * dominant current decision beside the rest of the queue. That is what makes it
 * a queue and not a feed, and the mockup keeps the primary decision dominant at
 * every width.
 *
 * Every decision states its action, its consequence, the exact versions it would
 * freeze, and who has the authority — the design contract's copy rule, and the
 * difference between an approval and a click.
 */
import type React from "react";
import { EmptyState, Textarea } from "@corbits/react-ui";
import { useState } from "react";
import type { ProjectDetail, Wait } from "../client.js";
import { Button, Screen, StateLabel, shortHash, stageName } from "../components.jsx";
import { ApprovalsRecord } from "./workspace.jsx";

/** What each stage's gate is called, in the approver's language. */
const ACTION: Record<number, string> = {
  1: "Accept the problem brief",
  2: "Accept the solution bounds",
  3: "Select this approach",
  4: "Approve the design",
  5: "Approve the concept",
  6: "Accept the plan",
  7: "Approve the spend",
  8: "Accept the build evidence",
  9: "Accept the delivery",
};

const SECONDARY: Record<number, string> = {
  1: "Send back for more discovery",
  2: "Narrow the bounds",
  3: "Ask for another approach",
  4: "Request a design revision",
  5: "Send back to the audiences",
  6: "Ask for a plan correction",
  7: "Request a cheaper plan",
  8: "Request remediation",
  9: "Reject the manifest",
};

export function DecisionQueue({
  decisions,
  detail,
  busy,
  onOpen,
  onDecide,
  onInspect,
  onStart,
  selectedProjectId,
}: {
  decisions: Wait[];
  detail: ProjectDetail | null;
  busy: string | null;
  selectedProjectId: string | null;
  onOpen: (wait: Wait) => void;
  onInspect: (wait: Wait) => void;
  /** Starting something is the other thing this page is for. */
  onStart: () => void;
  onDecide: (wait: Wait, decision: "approve" | "reject" | "revise", reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const current =
    decisions.find((wait) => wait.projectId === selectedProjectId) ?? decisions[0];
  const rest = decisions.filter((wait) => wait.id !== current?.id);

  // An empty queue is not an empty screen. Nothing waiting means the next
  // thing a person does is start something, so that is what it offers.
  if (decisions.length === 0) {
    return (
      <>
        <Screen title="Nothing is waiting on you">
          <EmptyState
            title="No decision is open"
            description="Every stage that needed you has been answered. The host keeps working while this window is closed."
            action={
              <Button variant="primary" onClick={onStart}>
                Start something new
              </Button>
            }
          />
        </Screen>
        {detail ? <ApprovalsRecord approvals={detail.approvals} /> : null}
      </>
    );
  }

  const versions = current
    ? (detail?.nodes ?? []).filter(
        (node) => node.stage === current.stage && node.supersededByNodeId === null,
      )
    : [];
  const canApprove = versions.length > 0;

  return (
    <Screen
      title="Decision Queue"
      priority
      status={
        <div
          className="queue-count"
          role="status"
          aria-label={`${decisions.length} decisions require human action`}
        >
          <strong>{decisions.length}</strong>
          <span>waiting</span>
        </div>
      }
    >
      <div className="bento">
        <article className="span-8 decision-current" aria-labelledby="current-decision">
          <div className="decision-meta">
            <StateLabel tone="warning">Action required</StateLabel>
            <span>Project: {current?.projectTitle ?? "—"}</span>
            <span>
              Stage {current?.stage} — {stageName(current?.stage ?? null)}
            </span>
          </div>

          <h3 id="current-decision">
            {ACTION[current?.stage ?? 1] ?? current?.title}
          </h3>
          <p className="consequence">{current?.consequence}</p>

          <dl className="version-list">
            <div>
              <dt>Exact artifacts</dt>
              <dd>
                {versions.length === 0 ? (
                  <span className="hash">No unsuperseded version at this stage.</span>
                ) : (
                  versions.map((node) => (
                    <div key={node.id}>
                      {node.variant ? `${node.variant}: ` : ""}
                      {node.kind.replace(/_/g, " ")} v{node.version}{" "}
                      <span className="hash">sha256 {shortHash(node.contentHash)}</span>
                    </div>
                  ))
                )}
              </dd>
            </div>
            <div>
              <dt>Approver</dt>
              <dd>{current?.requiredAuthority.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt>Notification</dt>
              <dd>
                {current?.notifyError ? (
                  <StateLabel tone="warning">
                    Delivery failed. The request was kept
                  </StateLabel>
                ) : current?.notifiedAt ? (
                  <StateLabel tone="info">
                    Sent {new Date(current.notifiedAt).toLocaleTimeString()}
                  </StateLabel>
                ) : (
                  <StateLabel tone="disabled">Not sent</StateLabel>
                )}
              </dd>
            </div>
          </dl>

          <div className="field">
            <label htmlFor="decision-reason">
              Rationale, or the reason to route back
            </label>
            <Textarea
              id="decision-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Recorded with the decision, against these exact versions."
            />
          </div>

          <div className="action-row">
            <Button
              variant="primary"
              loading={busy === "approve"}
              disabled={!canApprove}
              onClick={() => current && onDecide(current, "approve", reason)}
            >
              {ACTION[current?.stage ?? 1] ?? "Approve"}
            </Button>
            <Button
              loading={busy === "revise"}
              onClick={() => current && onDecide(current, "revise", reason)}
            >
              {SECONDARY[current?.stage ?? 1] ?? "Send back"}
            </Button>
            <Button onClick={() => current && onInspect(current)}>Inspect evidence</Button>
          </div>
        </article>

        <aside className="span-4 queue-list" aria-label="Other pending decisions">
          <p className="queue-list-head">
            {rest.length === 0 ? "No other decisions" : `${rest.length} also waiting`}
          </p>
          {rest.map((wait, index) => (
            <button
              key={wait.id}
              type="button"
              className="queue-item stagger"
              style={{ "--i": index } as React.CSSProperties}
              onClick={() => onOpen(wait)}
            >
              <StateLabel tone={wait.stage === 7 ? "warning" : "info"}>
                {stageName(wait.stage)}
              </StateLabel>
              <strong>{ACTION[wait.stage] ?? wait.title}</strong>
              <p>{wait.projectTitle}</p>
            </button>
          ))}
        </aside>
      </div>
      {detail ? <ApprovalsRecord approvals={detail.approvals} /> : null}
    </Screen>
  );
}
