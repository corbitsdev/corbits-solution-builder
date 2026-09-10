/**
 * The markdown renderer, checked on the two things that matter: that a draft
 * reads as a document, and that nothing in a draft can become markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/ui/markdown.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const render = (source: string) => renderToStaticMarkup(Markdown({ source }));

const doc = render(`# Problem statement

Scheduling outreach **eats a morning** every week.

## What we know
- Reps copy names by hand
- The list goes stale in *days*

1. Pull the list
2. Draft the note

> The tool is the calendar, not the CRM.

\`\`\`
bun run outreach
\`\`\`

Use \`--dry-run\` first.
`);

check("headings render as headings", doc.includes("<h2>Problem statement</h2>"));
check("a second level nests below the first", doc.includes("<h3>What we know</h3>"));
check("bold renders", doc.includes("<strong>eats a morning</strong>"));
check("italic renders", doc.includes("<em>days</em>"));
check("bulleted lists render", doc.includes("<ul><li>Reps copy names by hand</li>"));
check("numbered lists render", doc.includes("<ol><li>Pull the list</li>"));
check("quotes render", doc.includes("<blockquote>The tool is the calendar"));
check("fenced code renders", doc.includes("<pre><code>bun run outreach</code></pre>"));
check("inline code renders", doc.includes("<code>--dry-run</code>"));
check("no marker leaks into the text", !doc.includes("##") && !doc.includes("**"));

// Wrapped paragraph lines are one paragraph, not one per line.
check(
  "wrapped lines join into a paragraph",
  render("one line\nand its continuation").includes("<p>one line and its continuation</p>"),
);

// The content comes from a model, so markup in it is text and stays text.
const hostile = render(
  '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[link](javascript:alert(1))',
);
check("script tags do not survive as markup", !hostile.includes("<script"));
check("script tags survive as text", hostile.includes("&lt;script&gt;"));
// `onerror=` is still in the output as *text* inside `&lt;img …&gt;`, which is
// inert. What must not exist is an unescaped tag for it to hang off.
check("no unescaped tag survives", !/<(?!\/?(p|h[234]|ul|ol|li|pre|code|blockquote|hr|strong|em|div)\b)/.test(hostile));
check("javascript: never becomes an href", !hostile.includes("href="));

// A heading marker inside a fence is code, not a heading.
check(
  "fences are verbatim",
  render("```\n# not a heading\n```").includes("<code># not a heading</code>"),
);

console.log(
  `\nMarkdown: ${passed}/${passed + failures.length} checks passed`,
);
if (failures.length > 0) process.exit(1);
