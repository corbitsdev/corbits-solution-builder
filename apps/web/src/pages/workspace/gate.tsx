import { Check } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { Button, StateLabel } from "../../components.jsx";
import type { Evaluation, ProjectDetail } from "../../client.js";

export const STAGE_GOAL: Record<number, string> = {
  1: "Describe what hurts. The Brainstormer interviews the problem, not a solution.",
  2: "Bound the shape: platforms, privacy, integrations, installation, and non-goals.",
  3: "Two approaches, compared on the same criteria. You pick one.",
  4: "Work out surfaces, flows, states, and the criteria a build will be measured against.",
  5: "Ensure buy-in from stakeholders.",
  6: "Turn the approved concept into a plan the code builder can execute, then review it four ways.",
  7: "Convert the accepted plan into a firm estimate, then approve the spend.",
  8: "Supervise the build. Humans decide permissions, material changes, and evidence.",
  9: "Review the manifest and accept or reject the delivered software.",
};

/**
 * The stage is written and waits on a decision. Working alone, the decision is
 * one click here and the next stage begins at once; with others involved, this
 * says who the wait is on and where to go.
 */
/** Stage 5's quorum as it stands: how many must proceed, how many have, how many block. */
export type Quorum = { needed: number; proceeded: number; blocked: number };

export function StageGate({
  soloApproval,
  busy,
  evaluation = null,
  quorum = null,
  onApprove,
  onOpenDecisions,
}: {
  soloApproval: boolean;
  busy: boolean;
  /** The stage-1 brief evaluator's verdict, advisory only. Null off stage 1. */
  evaluation?: Evaluation | null;
  /** Stage 5 only: the stakeholders' decisions, which approval waits on. */
  quorum?: Quorum | null;
  onApprove: () => void;
  onOpenDecisions?: (() => void) | undefined;
}) {
  // Stage 5 is approved only once enough stakeholders have said proceed and
  // none has blocked; the gate says which of those it is waiting on rather
  // than calling a version ready that the ledger would refuse.
  const quorumMet = quorum === null || (quorum.blocked === 0 && quorum.proceeded >= quorum.needed);
  const waiting =
    quorum === null
      ? null
      : quorum.blocked > 0
        ? "A stakeholder asked for a revise or reject, which blocks approval. Reopen the review below to revise the packages."
        : quorum.proceeded < quorum.needed
          ? `${quorum.proceeded} of ${quorum.needed} stakeholders have said proceed. Approval needs ${quorum.needed}; record the decisions below.`
          : null;
  return (
    <div className="stage-gate" role="status">
      <span
        className={evaluation?.ready || (quorum !== null && quorumMet) ? "stage-gate-dot is-ready" : "stage-gate-dot"}
        aria-hidden="true"
      />
      <p>
        {waiting ??
          (soloApproval
            ? quorum !== null
              ? "The stakeholders have said proceed. Approving starts the next stage."
              : "This version is ready. Approving it starts the next stage."
            : "This version is with the people who decide. It moves on when they have.")}
      </p>
      {soloApproval ? (
        <Button variant="primary" loading={busy} disabled={!quorumMet} onClick={onApprove}>
          <Check aria-hidden="true" />
          Approve and continue
        </Button>
      ) : onOpenDecisions ? (
        <Button variant="ghost" onClick={onOpenDecisions}>
          Open the decision queue
        </Button>
      ) : null}
    </div>
  );
}

/** Every decision recorded on this project, oldest first. Lives with the artifacts. */
export function ApprovalsRecord({ approvals }: { approvals: ProjectDetail["approvals"] }) {
  if (approvals.length === 0) return null;
  return (
    <details className="approvals-record">
      <summary>Recorded approvals ({approvals.length})</summary>
      <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {approvals.map((approval) => (
                <TableRow key={approval.id}>
                  <TableCell>{new Date(approval.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{approval.stage}</TableCell>
                  <TableCell>
                    {approval.command}
                    {approval.audienceName ? ` (${approval.audienceName})` : ""}
                  </TableCell>
                  <TableCell>
                    <StateLabel
                      tone={
                        approval.decision === "approve" || approval.decision === "accept"
                          ? "success"
                          : approval.decision === "reject"
                            ? "error"
                            : "warning"
                      }
                    >
                      {approval.decision}
                    </StateLabel>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
    </details>
  );
}
