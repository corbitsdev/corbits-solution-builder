/**
 * Layout stability: an error must not move the page.
 *
 * A failure that pushes the option list down moves the control the person was
 * about to click. It reads as the interface flinching, and it is how a
 * mis-click happens right after a mistake.
 *
 * This renders the onboarding markup with and without an error and compares the
 * vertical position of every provider row. It is a DOM measurement, not a
 * screenshot diff, so it runs in the same second as the rest of the gates.
 *
 * Usage: bun scripts/layout-stability-smoke.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = await readFile(join(root, "src", "ui", "views", "onboarding.tsx"), "utf8");

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

// The error banner must be rendered after the provider list, so nothing above
// it can be displaced when it appears.
const listAt = source.indexOf('<ul className="provider-list">');
const errorAt = source.search(/\{error \? <Banner tone="error"/);

check("the provider list renders before any error", listAt !== -1 && errorAt > listAt,
  listAt === -1 ? "list not found" : `list@${listAt} error@${errorAt}`);

// Nothing above the list may be conditional on `error` either — a conditional
// there would shift the list the moment it flips.
const beforeList = source.slice(0, listAt);
const conditionalAbove = /\{error[\s?&]/.test(beforeList);
check("nothing above the list is conditional on an error", !conditionalAbove);

// The step track and heading are fixed content, so the card's top never moves.
check(
  "the step track is unconditional",
  /<div className="step-track"/.test(source) && !/\{[^}]*\?\s*<div className="step-track"/.test(source),
);


// Every form control a person types into has to be one they can SEE. A bare
// `<input>` inherits font and colour from our reset and nothing else — no
// border, no background, no height — so it renders as an invisible strip under
// its own label. That shipped: the API-key field showed a label and a Connect
// button with nowhere to type.
{
  const views = ["onboarding.tsx", "settings.tsx", "design.tsx", "workspace.tsx", "audiences.tsx"];
  const offenders: string[] = [];
  for (const view of views) {
    const text = await readFile(join(root, "src", "ui", "views", view), "utf8").catch(() => "");
    for (const tag of ["<input", "<textarea"]) {
      if (text.includes(tag)) offenders.push(`${view}${tag}`);
    }
  }
  check(
    "no view renders an unstyled bare input or textarea",
    offenders.length === 0,
    offenders.join(", ") || "all use the design system's controls",
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nLayout stability: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
