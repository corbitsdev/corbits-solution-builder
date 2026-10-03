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
import { StateLabel } from "../../components.jsx";
import { InlineMarkdown } from "../../markdown.jsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import { parseStackRecord } from "@solutions-builder/app/stack";
import { HowItRuns } from "./how-it-runs.tsx";

type CostRow = { label: string; amount: string; basis: string };

const HEADING_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.+)$/;
// "**Label:** rest" or "**Label**: rest". A label holding its own asterisks is
// not one this can read, so it is left out rather than shown half-parsed.
const BOLD_LABEL_RE = /^\*\*([^*]+?):?\*\*:?\s+(.+)$/;
const PLAIN_LABEL_RE = /^([^*:]+):\s+(.+)$/;
// "- **<line>:** <amount> — <basis>", the shape the estimator is asked for.
const BASIS_SEPARATOR_RE = /\s+[—–]\s+/;
const LEADING_AMOUNT_RE = /^(\$[\d,.]+\s*[kKmM]?)\b[\s·—–-]*(.*)$/;
// Longer than this with no separator, the rest is prose, not an amount.
const BARE_AMOUNT_MAX = 60;

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

/** Every list item in a section, marker removed. Bold-led paragraphs are prose, not items. */
function bullets(section: string): string[] {
  return section.split("\n").flatMap((line) => {
    const match = BULLET_RE.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
}

/** A `**Label:** rest` or `Label: rest` item as its (label, rest) pair, or null. */
function labelled(item: string): { label: string; rest: string } | null {
  const match = BOLD_LABEL_RE.exec(item) ?? PLAIN_LABEL_RE.exec(item);
  return match ? { label: match[1]!.trim(), rest: match[2]!.trim() } : null;
}

function costRow({ label, rest }: { label: string; rest: string }): CostRow | null {
  const separator = BASIS_SEPARATOR_RE.exec(rest);
  if (separator) {
    return { label, amount: rest.slice(0, separator.index).trim(), basis: rest.slice(separator.index + separator[0].length).trim() };
  }
  const leading = LEADING_AMOUNT_RE.exec(rest);
  if (leading) return { label, amount: leading[1]!.trim(), basis: leading[2]!.trim() };
  return rest.length <= BARE_AMOUNT_MAX ? { label, amount: rest, basis: "" } : null;
}

function parseCostRows(section: string | null): CostRow[] {
  if (!section) return [];
  return bullets(section).flatMap((item) => {
    const pair = labelled(item);
    const row = pair ? costRow(pair) : null;
    return row ? [row] : [];
  });
}

/** Scope items from `## Scope priced`: each bullet is a priced piece of work. */
function parseScopeItems(section: string | null): string[] {
  if (!section) return [];
  return bullets(section);
}

function parseEstimate(body: string): { costRows: CostRow[]; scopeItems: string[] } {
  const byHeading = sections(body);
  const forecast = findSection(byHeading, /^forecast\b/i);
  const costAgainstForecast = findSection(byHeading, /cost against forecast/i);
  const scopePriced = findSection(byHeading, /scope priced/i);
  const costRows = [...parseCostRows(forecast), ...parseCostRows(costAgainstForecast)];
  return { costRows, scopeItems: parseScopeItems(scopePriced) };
}

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
  const { costRows, scopeItems } = useMemo(() => parseEstimate(body), [body]);
  const stack = useMemo(() => parseStackRecord(body), [body]);
  // The workflow's own freeze (once stage 7 is approved) is the only
  // authority on "frozen" -- never re-derived from artifact metadata.
  const frozen = freeze !== null;

  if (costRows.length === 0 && scopeItems.length === 0 && !frozen && !stack) return null;

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
