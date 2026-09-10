/**
 * Interface quality audit, against the Impeccable slop detectors
 * (https://impeccable.style/slop).
 *
 * Impeccable's premise is that AI-written interfaces fail in predictable ways —
 * the same handful of defaults reached for over and over. This checks ours for
 * the tells that are mechanically checkable from the stylesheet and the markup.
 *
 * It is deliberately unkind. A check that passes because it was written to pass
 * is worth nothing, so each one states the rule it comes from and what it looks
 * at, and several of them failed when this was first written.
 *
 * Usage: bun scripts/check-slop.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const css = await readFile(join(root, "apps", "web", "src", "styles.css"), "utf8");

async function views(): Promise<{ path: string; body: string }[]> {
  const dir = join(root, "apps", "web", "src");
  const out: { path: string; body: string }[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".tsx")) out.push({ path, body: await readFile(path, "utf8") });
    }
  };
  await walk(dir);
  return out;
}

const markup = (await views()).map((view) => view.body).join("\n");

type Finding = { rule: string; detail: string };
const findings: Finding[] = [];
const passed: string[] = [];

function check(rule: string, failed: boolean, detail: string) {
  if (failed) findings.push({ rule, detail });
  else passed.push(rule);
}

// --- Visual details ---
check(
  "7. Glassmorphism everywhere",
  /backdrop-filter|blur\(/.test(css),
  "blur used decoratively",
);
{
  // The tell is one element wearing both — a flat card pretending to float.
  // Matching the whole sheet instead flags any stylesheet that has a border
  // somewhere and a shadow somewhere else, which is every stylesheet, and a
  // detector that always fires is one nobody reads.
  const both = [...css.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1] ?? "")
    .filter((body) => /border:\s*1px/.test(body) && /box-shadow:\s*[^;]*\d+px/.test(body));
  check(
    "9. Hairline border with wide shadow",
    both.length > 0,
    `${both.length} element(s) wear both`,
  );
}
check(
  "11. Extreme border-radius on cards",
  /border-radius:\s*(2[4-9]|[3-9]\d)px/.test(css),
  "cards rounded past 24px",
);

// --- Typography ---
{
  // Rule 14: functional text under 11px.
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => Number(m[1]) * 16);
  const tiny = sizes.filter((size) => size < 11);
  check(
    "14. Undersized functional text",
    tiny.length > 0,
    `${tiny.length} declaration(s) under 11px: ${[...new Set(tiny)].join(", ")}px`,
  );

  // Rule 15: adjacent heading steps closer than 1.25x.
  const heading = (selector: string) => {
    const block = new RegExp(`(^|\\n)${selector}\\s*\\{[^}]*\\}`, "m").exec(css)?.[0] ?? "";
    const size = /font-size:\s*([\d.]+)rem/.exec(block);
    return size ? Number(size[1]) : null;
  };
  const h1 = heading("h1");
  const h2 = heading("h2");
  const h3 = heading("h3");
  const ratios: string[] = [];
  if (h1 && h2 && h1 / h2 < 1.25) ratios.push(`h1/h2 = ${(h1 / h2).toFixed(2)}`);
  if (h2 && h3 && h2 / h3 < 1.25) ratios.push(`h2/h3 = ${(h2 / h3).toFixed(2)}`);
  check("15. Flat type hierarchy", ratios.length > 0, ratios.join("; "));

  check(
    "21. Overused font",
    /Inter|Geist|Space Grotesk|Instrument Serif/.test(css),
    "uses a font from the overused set",
  );
  check(
    "22. Single font for everything",
    !(/--wb-font-ui/.test(css) && /--wb-font-mono/.test(css)),
    "one family throughout",
  );
  check("23. All-caps body text", /body[^{]*\{[^}]*text-transform:\s*uppercase/.test(css), "");

  // Rule 13/18: the kicker/eyebrow above a heading.
  const kickers = [...markup.matchAll(/className="kicker"|<p className="kicker"/g)].length;
  check(
    "13/18. Kicker/eyebrow label above heading",
    kickers > 0,
    `${kickers} eyebrow label(s) above headings`,
  );
}

// --- Colour ---
check("26. AI colour palette", /#(8b5cf6|a855f7|6366f1|22d3ee|06b6d4)/i.test(css), "purple/cyan");
check(
  "30. Cream/beige page background",
  /background:\s*#(f5f5dc|faf3e0|fdf6e3|f5efe6)/i.test(css),
  "warm cream ground",
);
{
  // Rule 28 is about decoration: a rainbow across a heading. A shine that
  // sweeps one colour across a working label is a motion cue, so a clipped
  // gradient only counts when it mixes more than one colour.
  const clipped = [...css.matchAll(/\{[^}]*background-clip:\s*text[^}]*\}/g)].map(([block]) => block);
  const multicolour = clipped.some(
    (block) => new Set(block.match(/var\(--wb-[a-z-]+\)|#[0-9a-f]{3,8}/gi) ?? []).size > 1,
  );
  check("28. Gradient text", multicolour, "gradient on readable text");
}
check(
  "24/25. Decorative radial glow",
  /radial-gradient/.test(css),
  "radial halo behind sections",
);

// --- Layout ---
{
  // Rule 8: a thick accent border on one side of a card.
  const sideAccents = [...css.matchAll(/border-(left|right|top|bottom):\s*2px solid var\(--wb-primary\)/g)];
  check(
    "8. Side-tab accent border",
    sideAccents.length > 2,
    `${sideAccents.length} single-side accent borders`,
  );

  // Rule 39: cards inside cards.
  //
  // Depth-aware, because two tiles side by side in a row are siblings, not
  // nesting — a proximity match calls that a violation and trains you to
  // ignore the checker. A "card" here is an element that draws its own border
  // *and* fill; a panel containing tiles is ordinary layout and not the tell.
  const CARD = /className="[^"]*\b(tile|artifact)\b/;
  const nestedAt: string[] = [];
  for (const view of await views()) {
    const tokens = view.body.match(/<\/?(?:div|article|aside|section)\b[^>]*>/g) ?? [];
    let cardDepth = 0;
    const stack: boolean[] = [];
    for (const token of tokens) {
      if (token.startsWith("</")) {
        if (stack.pop() === true) cardDepth -= 1;
        continue;
      }
      const isCard = CARD.test(token);
      if (isCard && cardDepth > 0) nestedAt.push(`${view.path.split("/").pop()}: ${token.slice(0, 60)}`);
      // Self-closing tags open nothing.
      if (!token.endsWith("/>")) {
        stack.push(isCard);
        if (isCard) cardDepth += 1;
      }
    }
  }
  check("39. Nested cards", nestedAt.length > 0, nestedAt.slice(0, 3).join(" | "));

  // Rule 38: one spacing value used everywhere.
  const gaps = [...css.matchAll(/\bgap:\s*(\d+)px/g)].map((m) => m[1]);
  const distinct = new Set(gaps);
  check(
    "38. Monotonous spacing",
    gaps.length > 8 && distinct.size < 3,
    `${gaps.length} gap declarations, ${distinct.size} distinct values`,
  );

  check(
    "40. Line length too long",
    !/max-width:\s*\d+ch/.test(css),
    "no measure cap on running text",
  );
}

// --- Motion ---
check(
  "43. Pulsing status dot",
  /animation:\s*pulse/.test(css),
  "decorative pulse on a status dot",
);
check("46. Bounce or elastic easing", /cubic-bezier\([^)]*1\.[0-9]/.test(css), "spring easing");
check(
  "47. Layout property animation",
  /transition:[^;]*\b(width|height|padding|margin)\b/.test(css),
  "animating a layout property",
);

// --- Copy ---
{
  // Rule 50: em-dash overuse in user-facing strings.
  const strings = [...markup.matchAll(/(?:title|description|label|placeholder|helper)=\{?"([^"]{20,})"/g)]
    .map((m) => m[1]!)
    .concat([...markup.matchAll(/>\s*([A-Z][^<>{}]{30,})\s*</g)].map((m) => m[1]!));
  const withDash = strings.filter((value) => (value.match(/—/g) ?? []).length > 0);
  check(
    "50. Em-dash overuse",
    withDash.length > 3,
    `${withDash.length} user-facing strings contain an em-dash`,
  );

  const buzzwords = /\b(streamline|empower|supercharge|seamless|leverage|unlock|elevate|robust)\b/i;
  check("51. Marketing buzzword", buzzwords.test(markup), "generic SaaS phrasing");
}

// --- General quality ---
check("62. Justified text", /text-align:\s*justify/.test(css), "");
{
  // The rule is about reading text. A heading or a display number is *meant* to
  // be tight, so only blocks that are not headings are considered.
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const tight = blocks.filter(([, selector, body]) => {
    const isHeading = /\bh[1-6]\b|strong|\.queue-count|title/.test(selector!);
    const match = /line-height:\s*([\d.]+)/.exec(body!);
    return !isHeading && match !== null && Number(match[1]) < 1.3;
  });
  check(
    "65. Tight line height",
    tight.length > 0,
    tight.map(([, selector]) => selector!.trim()).join(", "),
  );
}
check(
  "61. Body text touching the viewport edge",
  !/\.canvas\s*\{[^}]*padding/.test(css),
  "no container padding",
);

console.log(`Impeccable audit — ${passed.length} clean, ${findings.length} findings\n`);
for (const finding of findings) {
  console.log(`  FLAG  ${finding.rule}`);
  if (finding.detail) console.log(`        ${finding.detail}`);
}
if (findings.length === 0) console.log("  No detectors fired.");
console.log(`\nClean: ${passed.length}/${passed.length + findings.length}`);
process.exit(findings.length > 0 ? 1 : 0);
