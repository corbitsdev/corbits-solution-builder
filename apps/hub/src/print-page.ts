/**
 * A design, served as the page it is so it can be printed or saved as a PDF.
 *
 * A stage-4 design is one HTML document. The app reviews it inside a sandboxed
 * frame, and nothing outside a frame can print what is inside it, so printing
 * one means leaving the app for the document itself. This wraps it for that
 * trip: a bar along the top with the two things a person can do there, and a
 * policy that lets the document's own styles through and nothing else.
 *
 * The document is a model's output and is not trusted. The policy allows no
 * script but the bar's own, keyed by a nonce minted per response, no fetch
 * or frame or form, and no asset that is not inlined. The one thing it does
 * not do is sandbox the origin: the desktop shell answers the print request
 * only from the host's own origin, and an opaque one would be refused.
 */

/** Where the bar goes: just inside the body, or at the very top if there is none. */
const BODY_OPEN = /<body\b[^>]*>/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type PrintablePage = {
  body: string;
  headers: Record<string, string>;
};

/** The design with the print bar in it, and the headers it must be served with. */
export function printableDesign(args: { html: string; title: string; version: number }): PrintablePage {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const label = escapeHtml(`${args.title}, version ${args.version}`);
  const button =
    "font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #cfc7bf;background:#fff;color:inherit;cursor:pointer";
  const bar = [
    `<div data-print-bar style="position:sticky;top:0;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 16px;background:#fff;color:#2b2627;border-bottom:1px solid #e3ddd6;font:14px/1.4 -apple-system,system-ui,sans-serif">`,
    `<strong style="margin-right:auto;font-weight:600">${label}</strong>`,
    `<button type="button" data-print-back style="${button}">Back to the app</button>`,
    `<button type="button" data-print-now style="${button};background:#e98428;border-color:#e98428;color:#fff">Print or save as PDF</button>`,
    `</div>`,
    `<style nonce="${nonce}">@media print{[data-print-bar]{display:none !important}}</style>`,
    `<script nonce="${nonce}">` +
      `document.querySelector("[data-print-now]").addEventListener("click",function(){window.print()});` +
      `document.querySelector("[data-print-back]").addEventListener("click",function(){history.back()});` +
      `</script>`,
  ].join("");

  const match = BODY_OPEN.exec(args.html);
  const body = match
    ? `${args.html.slice(0, match.index + match[0].length)}${bar}${args.html.slice(match.index + match[0].length)}`
    : `${bar}${args.html}`;

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    // The desktop shell's print command travels over its IPC scheme.
    "connect-src ipc: http://ipc.localhost",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");

  return {
    body,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  };
}
