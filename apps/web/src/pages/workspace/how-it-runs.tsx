/**
 * "How it will actually run" (CL-8862): the plain-language read of the
 * Architect's stack decision. The person never picks a stack and never sees
 * a package name here -- only what happens, where, and for whom, each field
 * derived structurally by `describeOperation` from the parsed `StackRecord`.
 * Renders nothing when the plan text has no valid `## Stack` block yet.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { describeOperation, parseStackRecord, type OperationDescription } from "@solutions-builder/app/stack";

const FIELDS: readonly { key: keyof OperationDescription; label: string }[] = [
  { key: "start", label: "Starting it" },
  { key: "where", label: "Where it runs" },
  { key: "who", label: "Who it's for" },
  { key: "needs", label: "What it needs" },
  { key: "cost", label: "Ongoing cost" },
  { key: "shareOrCloud", label: "Shared, or cloud" },
];

export function HowItRuns({ planText }: { planText: string }) {
  const stack = parseStackRecord(planText);
  if (!stack) return null;
  const description = describeOperation(stack);
  return (
    <div className="how-it-runs">
      <h2>How it will actually run</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Question</TableHead>
            <TableHead>Answer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {FIELDS.map(({ key, label }) => (
            <TableRow key={key}>
              <TableCell>{label}</TableCell>
              <TableCell>{description[key]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
