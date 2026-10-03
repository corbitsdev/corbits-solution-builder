import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimateView, parseEstimate } from "./estimate.tsx";

function estimate(forecast: string, scope = "Tasks 1 to 24 of the accepted plan, as written."): string {
  return ["Firm estimate.", "", "## In short", "", "- **Build: $390–770** — mostly inference.", "", "## Scope priced", "", scope, "", "## Forecast", "", forecast, "", "## Unknowns", "", "- **Coverage**: unknown."].join("\n");
}

// #623: the forecast as an estimator wrote it, bold labels over tables.
const TABLED = [
  "All figures USD. **Build, one-time:**",
  "",
  "| Line | Low | High |",
  "|---|---|---|",
  "| Inference — tasks 1–3 | 40 | 80 |",
  "| Domain registration, year one | 15 | 20 |",
  "| **Total** | **390** | **770** |",
  "",
  "Slightly above the proposal's rough figure.",
  "",
  "**Run, monthly:**",
  "",
  "| Line | Low | High |",
  "|---|---|---|",
  "| Hosting | 40 | 80 |",
  "| **Total** | **~130** | **~370** |",
  "",
  "Expected figure at the assumed usage: **about $210/month**. Every line is attributable.",
  "",
  "**Time:** 15–22 hours of coding-agent wall-clock; 4–6 elapsed days.",
].join("\n");

describe("parseEstimate", () => {
  test("a bold label over a table of lines is read as that table's Total, in the stated currency", () => {
    const { costRows } = parseEstimate(estimate(TABLED));
    expect(costRows).toEqual([
      { label: "Build, one-time", amount: "390–770 USD", basis: "Total of 2 lines" },
      { label: "Run, monthly", amount: "~130–~370 USD", basis: "Total of 1 line" },
      { label: "Time", amount: "15–22 hours of coding-agent wall-clock; 4–6 elapsed days.", basis: "" },
    ]);
  });

  test("no cell keeps its markup, and a bold paragraph is not taken for a list item", () => {
    const { costRows, scopeItems } = parseEstimate(estimate(TABLED, "**Everything in the plan.** Nothing else."));
    for (const row of costRows) expect(`${row.label}${row.amount}${row.basis}`).not.toContain("*");
    expect(scopeItems).toEqual([]);
  });

  test("a total that carries its own currency mark is left as written", () => {
    const { costRows } = parseEstimate(estimate(["All figures USD.", "", "**Build:**", "", "| Line | Cost |", "|---|---|", "| Inference | $300 |", "| Total | $300 |"].join("\n")));
    expect(costRows).toEqual([{ label: "Build", amount: "$300", basis: "Total of 1 line" }]);
  });

  test("a table with no Total row, or under no label, gives no row", () => {
    const untotalled = ["**Build:**", "", "| Line | Cost |", "|---|---|", "| Inference | 300 |"].join("\n");
    const unlabelled = ["| Line | Cost |", "|---|---|", "| Total | 300 |"].join("\n");
    expect(parseEstimate(estimate(untotalled)).costRows).toEqual([]);
    expect(parseEstimate(estimate(unlabelled)).costRows).toEqual([]);
  });

  test("list items are read as before: a money figure is the amount, what follows its basis", () => {
    const listed = ["- **Build:** $420 — 24 rounds of the coding agent", "- Run: $210 per month", "* **Time**: about 18 hours"].join("\n");
    expect(parseEstimate(estimate(listed)).costRows).toEqual([
      { label: "Build", amount: "$420", basis: "24 rounds of the coding agent" },
      { label: "Run", amount: "$210", basis: "per month" },
      { label: "Time", amount: "about 18 hours", basis: "" },
    ]);
  });

  test("scope items are the section's list items", () => {
    const { scopeItems } = parseEstimate(estimate("- Build: $1", "- **Person file:** four layers\n- The seed script"));
    expect(scopeItems).toEqual(["Person file — four layers"]);
    expect(parseEstimate(estimate("- Build: $1", "- The seed script\n- **The test suite**")).scopeItems).toEqual(["The seed script", "The test suite"]);
  });
});

describe("EstimateView", () => {
  test("shows the totals an estimator gave in tables", () => {
    const html = renderToStaticMarkup(createElement(EstimateView, { body: estimate(TABLED) }));
    expect(html).toContain("Build, one-time");
    expect(html).toContain("390–770 USD");
    expect(html).toContain("~130–~370 USD");
    expect(html).not.toContain("*Run");
  });

  test("renders nothing for an estimate with no figures it can read", () => {
    expect(renderToStaticMarkup(createElement(EstimateView, { body: "## Forecast\n\nA paragraph of prose." }))).toBe("");
  });
});
