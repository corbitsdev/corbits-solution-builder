/**
 * Stage 7's structured estimate view.
 *
 * A person deciding whether to freeze a target wants the numbers and the
 * priced scope at a glance first. The Estimator writes them twice: as prose
 * for people, and as one fenced ```json estimate block (`estimate.ts`) that
 * this table is drawn from, so nothing here is read out of the prose.
 */
import { useMemo } from "react";
import { StateLabel } from "../../components.jsx";
import { InlineMarkdown } from "../../markdown.jsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { readEstimateRecord } from "@solutions-builder/app/estimate";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import { parseStackRecord } from "@solutions-builder/app/stack";
import { HowItRuns } from "./how-it-runs.tsx";

export function EstimateView({
  body,
  freeze = null,
}: {
  body: string;
  /** The project workflow's own freeze, once stage 7 is approved
   *  (`ProjectWorkflowView.freeze`) -- the process authority, not a guess
   *  from artifact metadata. */
  freeze?: Freeze | null;
}) {
  const estimate = useMemo(() => readEstimateRecord(body), [body]);
  const costRows = estimate.status === "read" ? estimate.record.lines : [];
  const scopeItems = estimate.status === "read" ? estimate.record.scope : [];
  const stack = useMemo(() => parseStackRecord(body), [body]);
  // The workflow's own freeze (once stage 7 is approved) is the only
  // authority on "frozen" -- never re-derived from artifact metadata.
  const frozen = freeze !== null;

  if (estimate.status === "absent" && !frozen && !stack) return null;

  return (
    <div className="stage-lead estimate-view">
      {stack ? <HowItRuns planText={body} /> : null}
      {frozen ? (
        <div className="button-row">
          <StateLabel tone="success">Approved · frozen</StateLabel>
        </div>
      ) : null}
      {freeze ? (
        <ul className="scope-checklist">
          {freeze.frozen.map((ref) => (
            <li key={ref.stage}>
              Stage {ref.stage} frozen at version {ref.version}
            </li>
          ))}
        </ul>
      ) : null}
      {estimate.status === "invalid" ? (
        <p className="inline-note">The estimate's forecast block could not be read: {estimate.reason}</p>
      ) : null}
      {costRows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Basis</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {costRows.map((row, index) => (
              <TableRow key={index}>
                <TableCell>
                  <InlineMarkdown source={row.label} />
                </TableCell>
                <TableCell>
                  <InlineMarkdown source={row.amount} />
                </TableCell>
                <TableCell>{row.basis ? <InlineMarkdown source={row.basis} /> : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {scopeItems.length > 0 ? (
        <ul className="scope-checklist">
          {scopeItems.map((item, index) => (
            <li key={index}>
              <input type="checkbox" checked readOnly /> <InlineMarkdown source={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
