/**
 * The app's stylesheet must not fork the design system, and must not drift
 * apart from the markup it styles.
 *
 * This app carried a `--wb-*` copy of the Corbits palette for months. A copy
 * looks harmless the day it is made and is wrong by the next release: this one
 * had lost the secondary and accent steps, which is why every non-primary
 * surface fell back to the same grey, and being a copy of the *light* values
 * it could not go dark at all.
 *
 * A design review then broke the first version of this file three ways, and
 * each hole is worth naming because each is the obvious way to write the
 * check:
 *
 *   - `markup.includes(name)` is a substring test, so `.rail` was "used" by
 *     `rail-note` and any prefix of any live class was immortal;
 *   - class names were read out of the raw CSS, comments included, so a
 *     deleted rule stayed "declared" as long as a comment mentioned it — and
 *     this file's house style names classes in prose constantly;
 *   - only `className="…"` and `` className={`…`} `` were scanned, so a class
 *     inside a ternary was invisible to both directions.
 *
 * So: comments are stripped before anything is read, names are matched on word
 * boundaries, and every string literal in a `className` is collected however
 * it is spelled.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SHEET = "apps/web/src/styles.css";
const raw = await readFile(SHEET, "utf8");
/**
 * Comments are prose about the code, never the code.
 *
 * Block comments and whole-line `//` comments both go. Trailing `//` is left
 * alone so a marker like `// not-our-surface` stays attached to its line — and
 * so a URL never loses its scheme.
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");
const css = strip(raw);

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Every source file that can carry a colour or a class name. */
async function sources(): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "assets") await walk(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push({ file: path, text: await readFile(path, "utf8") });
      }
    }
  }
  await walk("apps/web/src");
  await walk("scripts");
  return found;
}

const files = await sources();

// --- The palette ---
{
  // Checked across every component and the harness, not just the sheet: the
  // first version of this gate passed while six hardcoded hexes sat in
  // tour.tsx rendering a white card over a dark app, and the brand orange was
  // spelled out in the very harness that produced the screenshots.
  const offenders: string[] = [];
  for (const { file, text } of [{ file: SHEET, text: css }, ...files]) {
    for (const line of strip(text).split("\n")) {
      // Named colours count: `color: red` is as much a decision taken here as
      // `color: #ff0000`, and the first version of this gate let it through.
      const NAMED = /:\s*(red|blue|green|orange|purple|yellow|pink|black|white|gr[ae]y|cyan|magenta|brown|teal|navy|olive|lime|maroon|silver|gold)\b/;
      // By function name, not by literal shape: a hand-mixed brand orange in
      // hsl() or oklch() is as much a fork as one in hex, and the first
      // version of this gate could not see either.
      const FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;
      if (!/#[0-9a-fA-F]{3,8}\b/.test(line) && !FUNCTION.test(line) && !NAMED.test(line)) continue;
      // A `token("--x", "#hex")` fallback is what is used when the theme
      // cannot be read at all; a last resort, not a choice.
      if (/token\(\s*"--[a-z-]+",\s*"#[0-9a-fA-F]{3,8}"\s*\)/.test(line)) continue;
      // A shade of black behind a floating surface is not a palette entry, and
      // the system exposes no shadow token at this revision.
      if (/box-shadow|rgb\(0 0 0/.test(line)) continue;
      // A surface this app does not own — a generated mockup in a sandboxed
      // frame — renders on its own ground, not the app's theme.
      if (line.includes("not-our-surface")) continue;
      offenders.push(`${file}: ${line.trim().slice(0, 44)}`);
    }
  }
  check("no colour is spelled out", offenders.length === 0, offenders.slice(0, 3).join(" | "));
}

const locals = [...css.matchAll(/(--wb-[a-z-]+):\s*([^;]+);/g)];
check(
  "every --wb-* token aliases a system token",
  locals.every(([, , value]) => /var\(--/.test(value ?? "")),
  locals.filter(([, , v]) => !/var\(--/.test(v ?? "")).map(([, n]) => n).join(", "),
);
{
  // An alias nothing reads is the same fiction as a fork: the palette claims a
  // step the interface never draws.
  const unused = locals
    .map(([, name]) => name!)
    .filter((name) => !new RegExp(`var\\(${name}[,)]`).test(css));
  check("every alias is actually used", unused.length === 0, unused.join(", "));
}
check("the sheet does not pin a colour scheme", !/color-scheme:\s*light/.test(css));

// --- The spacing scale ---
{
  // Insets, gaps and radii all place things relative to each other, so all
  // three come from the scale. Scope is this stylesheet: an SVG's own geometry
  // and an embedded frame's height are sizes of things, not spacing between
  // them, and they live in the components that draw them. Checking only `padding` let a 6px gap and a
  // 14px radius sit beside tokens that were the point of the exercise.
  const SPACED = /(?:padding|margin|gap|inset|border-radius)[a-z-]*:\s*([^;]+);/g;
  const offenders = [...css.matchAll(SPACED)]
    .map((match) => match[1]!.trim())
    .filter((value) => /\b\d+px/.test(value))
    // 1-2px is optical alignment on a chip or an icon button, not spacing, so
    // it may sit beside a scale value in the same declaration.
    .filter((value) => !/^(-?[12]px|var\(--space-[0-9]+\))(\s+(-?[12]px|var\(--space-[0-9]+\)))*$/.test(value))
    // calc() and clamp() are allowed to *compose* the scale, not to smuggle a
    // raw value past it: `calc(var(--space-5) + 44px)` is deliberate, and
    // `calc(13px)` is the gate being walked around.
    .filter((value) => !/clamp\(/.test(value))
    .filter((value) => !(/calc\(/.test(value) && /var\(--(space|radius)/.test(value)))
    // A pill is fully rounded rather than a step on any scale.
    .filter((value) => !/^999px$/.test(value));
  check("spacing comes from the scale", offenders.length === 0, offenders.slice(0, 4).join(" | "));
}

// --- The shape of the sheet itself ---
{
  // A selector list left dangling by a deletion silently changes what a rule
  // matches. It has happened twice: `.provider-row` became one descendant
  // chain matching nothing, and `button, input, select,` ran on into
  // `:focus-visible`, putting a permanent focus ring on every control in the
  // app. Neither is a syntax error, so nothing else catches them.
  // A selector list whose next line opens a new rule rather than continuing
  // the list. Catches both shapes: the deleted line blanked, and the deleted
  // line removed outright — which is the likelier of the two and the one the
  // first version of this check missed.
  // Two shapes, and only two, so a legitimate multi-line list ending in a
  // plain selector is not flagged: a comma with a blank line after it, or a
  // comma whose list continues with a bare pseudo-class or at-rule — which is
  // what `button, input, select,` running on into `:focus-visible` looks like.
  const dangling = [
    ...css.matchAll(/,[ \t]*\n[ \t]*\n/g),
    ...css.matchAll(/,[ \t]*\n[ \t]*[:@]/g),
  ];
  check("no selector list is left dangling", dangling.length === 0, `${dangling.length} found`);

  // Two class selectors separated only by whitespace is a descendant chain.
  // Written deliberately it is rare; produced by a deletion it is silent.
  const chains = [...css.matchAll(/\.([a-z][a-z0-9-]+)\s+\.\1(?![a-z0-9-])/g)];
  check("no selector repeats itself as its own descendant", chains.length === 0);

  const empty = [...css.matchAll(/\{\s*\}/g)];
  check("no rule is empty", empty.length === 0, `${empty.length} found`);
}

// --- The sheet and the markup ---
{
  // Markup lives in .tsx. A .ts file that happens to contain the string
  // "className=" — this one does — is not markup.
  const markup = files
    .filter(({ file }) => file.endsWith(".tsx"))
    .map(({ text }) => strip(text))
    .join("\n");
  const declared = new Set([...css.matchAll(/\.([a-z][a-z0-9-]+)/g)].map((match) => match[1]!));

  // Utility classes are the library's, in either direction: a rule of ours may
  // hook one, and markup may wear one we never style.
  const TAILWIND =
    /^(flex|grid|gap|min|max|w|h|p[xytblr]?|m[xytblr]?|text|font|bg|border|rounded|items|justify|truncate|shrink|overflow|animate|sr|space|leading|opacity|absolute|relative|fixed|inline|block|hidden|size|top|right|bottom|left|z|order|self|col|row|whitespace|break|cursor|select|pointer|transition|duration|ease|hover|focus|active|disabled|dark|group)(-|$)/;
  const external = /^(is-|has-|dark$|md$|woff2$|span-|rail-section$)/;

  // Every string literal inside a className, however it is spelled — quoted,
  // templated, or a branch of a ternary. Scanned with balanced braces rather
  // than a regex: an expression containing an object literal or a nested
  // template ends a lazy `\{...\}` match in the wrong place, and a class the
  // gate cannot see is a class it silently exempts.
  const used = new Set<string>();
  const add = (text: string) => {
    for (const name of text.split(/\s+/)) if (name) used.add(name);
  };
  for (let at = markup.indexOf("className="); at !== -1; at = markup.indexOf("className=", at + 1)) {
    const start = at + "className=".length;
    if (markup[start] === '"') {
      const end = markup.indexOf('"', start + 1);
      if (end !== -1) add(markup.slice(start + 1, end));
      continue;
    }
    if (markup[start] !== "{") continue;
    let depth = 0;
    let end = start;
    for (; end < markup.length; end += 1) {
      if (markup[end] === "{") depth += 1;
      else if (markup[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // `${...}` is an expression, and leaving it in truncates the literal
    // around it — `canvas-body${x}` would be read as the class "canvas-body${x".
    const expression = markup.slice(start + 1, end).replace(/\$\{[^}]*\}/g, " ");
    for (const quoted of expression.matchAll(/["'`]([^"'`]*)["'`]/g)) add(quoted[1] ?? "");
  }

  // The utility amnesty applies to markup only. Applied to declared names as
  // well it made any rule called `.p-…`, `.w-…` or `.text-…` immortal, which
  // is a whole family of orphans the gate could never report.
  // Classes this app deliberately hooks in the library's own markup. A short,
  // named list rather than a prefix rule: a prefix rule exempted every name
  // beginning `p-`, `w-` or `text-` from orphan detection in both directions.
  const HOOKED = new Set(["items-end"]);
  const orphans = [...declared].filter(
    (name) => !external.test(name) && !HOOKED.has(name) && !used.has(name),
  );
  check("no rule outlives the markup it styled", orphans.length === 0, orphans.slice(0, 6).join(", "));

  const unstyled = [...used].filter(
    (name) => /^[a-z][a-z0-9-]*$/.test(name) && !TAILWIND.test(name) && !declared.has(name),
  );
  check("no markup outlives the rule that styled it", unstyled.length === 0, unstyled.slice(0, 8).join(", "));
}

console.log(`\nToken discipline: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
