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
export function StageGate({
  soloApproval,
  busy,
  evaluation = null,
  onApprove,
  onOpenDecisions,
}: {
  soloApproval: boolean;
  busy: boolean;
  /** The stage-1 brief evaluator's verdict, advisory only. Null off stage 1. */
  evaluation?: Evaluation | null;
  onApprove: () => void;
  onOpenDecisions?: (() => void) | undefined;
}) {
  return (
    <div className="stage-gate" role="status">
      <span
        className={evaluation?.ready ? "stage-gate-dot is-ready" : "stage-gate-dot"}
        aria-hidden="true"
      />
      <p>
        {soloApproval
          ? "This version is ready. Approving it starts the next stage."
          : "This version is with the people who decide. It moves on when they have."}
      </p>
      {soloApproval ? (
        <Button variant="primary" loading={busy} onClick={onApprove}>
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
