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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import type { Freeze } from "@solutions-builder/app/project-workflow/contracts";
import { parseStackRecord } from "@solutions-builder/app/stack";
import { HowItRuns } from "./how-it-runs.tsx";

export type CostRow = { label: string; amount: string; basis: string };

const HEADING_RE = /^##\s+(.+?)\s*$/;
/** A list item: its marker, then a space. A paragraph that opens with `**bold**` is not one (#623). */
const BULLET_RE = /^[-*+]\s+(.*)$/;
const BOLD_BULLET_RE = /^\*\*([^*]+)\*\*:?\s*(.+)$/;
const PLAIN_BULLET_RE = /^([^:]+):\s*(.+)$/;
/** A bold label ending in a colon, inside the bold or just after it, wherever it sits on its line. */
const BOLD_LABEL_RE = /\*\*([^*]+?)(?::\*\*|\*\*:)\s*(.*)$/;
const AMOUNT_RE = /\$[\d,.]+\s*[kKmM]?\b/;
/** The currency a forecast states by code ("All figures USD"), for totals written as bare numbers. */
const CURRENCY_CODE_RE = /\b(USD|EUR|GBP|CAD|AUD|CHF|JPY)\b/;
const CURRENCY_MARK_RE = /[$€£¥]/;
const TABLE_RULE_RE = /^:?-{2,}:?$/;

/** A cell or label as plain text: no bold markers, no trailing colon. */
function plain(text: string): string {
  return text.replace(/\*\*/g, "").trim().replace(/:$/, "").trim();
}

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

/** A `- **Label:** value` or `- Label: value` list item as a (label, rest) pair, or null for any other line. */
function bulletPair(line: string): { label: string; rest: string } | null {
  const item = BULLET_RE.exec(line.trim());
  if (!item) return null;
  const match = BOLD_BULLET_RE.exec(item[1]!) ?? PLAIN_BULLET_RE.exec(item[1]!);
  return match ? { label: plain(match[1]!), rest: match[2]!.trim() } : null;
}

/** Every such list item in a section. */
function bulletPairs(section: string): { label: string; rest: string }[] {
  return section.split("\n").flatMap((line) => bulletPair(line) ?? []);
}

/** A label and what was written after it, as a row: the first money figure is the amount, the remainder its basis. */
function costRow(label: string, rest: string): CostRow {
  const text = rest.replace(/\*\*/g, "").trim();
  const amount = AMOUNT_RE.exec(text);
  return {
    label,
    amount: amount ? amount[0].trim() : text,
    basis: amount ? text.slice(amount.index + amount[0].length).replace(/^[\s·—-]+/, "").trim() : "",
  };
}

/** A table row's cells, without the outer pipes. */
function tableCells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/**
 * A table of priced lines as one row: its Total row's figures, low to high,
 * in the currency the forecast states. A table with no Total row has no
 * figure to give, and gives no row.
 */
function totalRow(label: string, table: readonly string[][], currency: string | null): CostRow | null {
  const body = table.filter((cells) => !cells.every((cell) => TABLE_RULE_RE.test(cell)));
  const total = body.find((cells) => /^total\b/i.test(plain(cells[0] ?? "")));
  if (!total) return null;
  const figures = total.slice(1).map(plain).filter((cell) => cell !== "");
  if (figures.length === 0) return null;
  const amount = figures.join("–");
  const stated = currency !== null && !CURRENCY_MARK_RE.test(amount) && !CURRENCY_CODE_RE.test(amount) ? `${amount} ${currency}` : amount;
  // The header and the Total row are not priced lines.
  const lines = body.length - 2;
  return { label, amount: stated, basis: lines > 0 ? `Total of ${String(lines)} line${lines === 1 ? "" : "s"}` : "" };
}

/**
 * The forecast's figures, in the order written, whichever way the estimator
 * laid them out (#623): list items (`- **Label:** value`), bold-labelled
 * lines (`**Time:** 15 hours`), and a bold label followed by a table of
 * priced lines, read as that table's Total.
 */
function parseCostRows(section: string | null): CostRow[] {
  if (!section) return [];
  const currency = CURRENCY_CODE_RE.exec(section)?.[1] ?? null;
  const rows: CostRow[] = [];
  // A bold label written with nothing after it: the table beneath is its figure.
  let waiting: string | null = null;
  let table: string[][] = [];
  const closeTable = () => {
    if (table.length === 0) return;
    const row = waiting !== null ? totalRow(waiting, table, currency) : null;
    if (row) rows.push(row);
    waiting = null;
    table = [];
  };
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("|")) {
      table.push(tableCells(line));
      continue;
    }
    closeTable();
    if (BULLET_RE.test(line)) {
      const pair = bulletPair(line);
      if (pair) rows.push(costRow(pair.label, pair.rest));
      continue;
    }
    const labelled = BOLD_LABEL_RE.exec(line);
    if (!labelled) continue;
    const label = plain(labelled[1]!);
    if (labelled[2]!.trim()) {
      rows.push(costRow(label, labelled[2]!));
      waiting = null;
    } else {
      waiting = label;
    }
  }
  closeTable();
  return rows;
}

/** Scope items from `## Scope priced`: each bullet's label stands for a priced piece of work. */
function parseScopeItems(section: string | null): string[] {
  if (!section) return [];
  const pairs = bulletPairs(section);
  if (pairs.length > 0) return pairs.map(({ label, rest }) => (rest ? `${label} — ${rest}` : label));
  return section
    .split("\n")
    .flatMap((line) => BULLET_RE.exec(line.trim())?.[1] ?? [])
    .map((item) => item.replace(/\*\*/g, ""));
}

/** The summary's rows and scope items, read from the estimate's own text. */
export function parseEstimate(body: string): { costRows: CostRow[]; scopeItems: string[] } {
  const byHeading = sections(body);
  const forecast = findSection(byHeading, /forecast/i);
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
