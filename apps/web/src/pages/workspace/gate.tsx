import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { StateLabel } from "../../components.jsx";
import type { ProjectDetail } from "../../client.js";

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
