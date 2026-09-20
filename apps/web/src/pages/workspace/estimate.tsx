/**
 * Stage 7's structured estimate view.
 *
 * The estimator's reply is prose, but a person deciding whether to freeze a
 * target wants the numbers and the priced scope at a glance first. This
 * folds a compact cost table and a scope checklist out of the same markdown
 * the full document already renders — never a second source of truth, just
 * a read of the reply's own `## Forecast` / `## Cost against forecast` /
 * `## Scope priced` sections. When the reply does not use those headings
 * this renders nothing, so a plain-prose estimate looks exactly as it did
 * before.
 */
import { useMemo } from "react";
import type { ProjectDetail } from "../../client.js";
import { StateLabel } from "../../components.jsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { SELECTABLE_TARGETS } from "@solutions-builder/app/targets";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";

type CostRow = { label: string; amount: string; basis: string };

const HEADING_RE = /^##\s+(.+?)\s*$/;
const BOLD_BULLET_RE = /^\*\*([^*]+)\*\*:?\s*(.+)$/;
const PLAIN_BULLET_RE = /^([^:]+):\s*(.+)$/;
const AMOUNT_RE = /\$[\d,.]+\s*[kKmM]?\b/;

/** The reply split into its `## Heading` sections, headings kept without `##`. */
function sections(body: string): Map<string, string> {
  const byHeading = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      current = heading[1]!.trim();
      byHeading.set(current, []);
      continue;
    }
    if (current) byHeading.get(current)!.push(line);
  }
  return new Map([...byHeading].map(([heading, lines]) => [heading, lines.join("\n")]));
}

function findSection(byHeading: Map<string, string>, pattern: RegExp): string | null {
  for (const [heading, body] of byHeading) {
    if (pattern.test(heading)) return body;
  }
  return null;
}

/** Every `- **Label:** value` or `- Label: value` line in a section, as a raw (label, rest) pair. */
function bulletPairs(section: string): { label: string; rest: string }[] {
  const pairs: { label: string; rest: string }[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("-") && !line.startsWith("*")) continue;
    const body = line.replace(/^[-*]\s*/, "");
    const match = BOLD_BULLET_RE.exec(body) ?? PLAIN_BULLET_RE.exec(body);
    if (!match) continue;
    pairs.push({ label: match[1]!.trim(), rest: match[2]!.trim() });
  }
  return pairs;
}

function parseCostRows(section: string | null): CostRow[] {
  if (!section) return [];
  return bulletPairs(section).map(({ label, rest }) => {
    const amount = AMOUNT_RE.exec(rest);
    return {
      label,
      amount: amount ? amount[0] : rest,
      basis: amount ? rest.slice(amount.index + amount[0].length).replace(/^[\s·—-]+/, "").trim() : "",
    };
  });
}

/** Scope items from `## Scope priced`: each bullet's label stands for a priced piece of work. */
function parseScopeItems(section: string | null): string[] {
  if (!section) return [];
  const pairs = bulletPairs(section);
  if (pairs.length > 0) return pairs.map(({ label, rest }) => (rest ? `${label} — ${rest}` : label));
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"))
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/\*\*/g, ""));
}

function parseEstimate(body: string): { costRows: CostRow[]; scopeItems: string[] } {
  const byHeading = sections(body);
  const forecast = findSection(byHeading, /forecast/i);
  const costAgainstForecast = findSection(byHeading, /cost against forecast/i);
  const scopePriced = findSection(byHeading, /scope priced/i);
  const costRows = [...parseCostRows(forecast), ...parseCostRows(costAgainstForecast)];
  return { costRows, scopeItems: parseScopeItems(scopePriced) };
}

export function EstimateView({
  body,
  detail,
  stage,
  chosenTarget,
  freeze = null,
}: {
  body: string;
  detail: ProjectDetail;
  stage: number;
  chosenTarget: string | null;
  /** The project workflow's own freeze, once stage 7 is approved
   *  (`ProjectWorkflowView.freeze`) -- the process authority, not a guess
   *  from artifact metadata. */
  freeze?: Freeze | null;
}) {
  const { costRows, scopeItems } = useMemo(() => parseEstimate(body), [body]);
  const frozen =
    freeze !== null ||
    detail.nodes.some((node) => node.stage === stage && node.supersededByNodeId === null && node.approvedAt !== null);
  const targetLabel = chosenTarget
    ? (SELECTABLE_TARGETS.find((option) => option.target === chosenTarget)?.label ?? chosenTarget)
    : null;

  if (costRows.length === 0 && scopeItems.length === 0 && !targetLabel && !frozen) return null;

  return (
    <div className="estimate-view">
      {targetLabel || frozen ? (
        <div className="button-row">
          {targetLabel ? <StateLabel tone="info">Target chosen: {targetLabel}</StateLabel> : null}
          {frozen ? <StateLabel tone="success">Approved · frozen</StateLabel> : null}
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
                <TableCell>{row.label}</TableCell>
                <TableCell>{row.amount}</TableCell>
                <TableCell>{row.basis || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {scopeItems.length > 0 ? (
        <ul className="scope-checklist">
          {scopeItems.map((item, index) => (
            <li key={index}>
              <input type="checkbox" checked readOnly /> {item}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
