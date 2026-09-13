export interface CallbackPageCopy {
  readonly productName: string;
  readonly siteUrl: string;
  readonly siteLabel: string;
  readonly githubUrl: string;
  readonly githubLabel: string;
}

/**
 * The page an OAuth provider redirects back to — the last thing a person sees
 * before returning to the app, so it carries the brand rather than a
 * browser's default serif on white. Ported from Corbits Code's
 * `auth/callback-page.ts`: the mark animates through the same dithered
 * draw/fill timeline, drawn in pixels the way the terminal draws it in block
 * characters.
 *
 * Everything is inline. The loopback server has no asset route, and a page
 * that reached out to a CDN would be a network call made by a local
 * authorization callback.
 */

/** The mark silhouette, as authored (viewBox 0 0 500 500). */
const MARK_PATH =
  "M392.899 189.107L397.586 197.031C397.586 197.031 399.539 202.891 399.539 204.844L403.094 222.422C407 222.813 407.39 226.328 409.734 227.109C412.078 228.281 415.203 231.797 416.765 235.313C417.156 236.875 418.718 240.781 420.671 244.688C422.234 247.422 422.625 250.156 424.578 251.719L426.921 254.062C432.39 258.359 432.781 261.484 433.171 272.422C432.781 280.625 434.734 295.078 435.906 301.328C436.296 302.891 436.296 302.891 437.468 303.281C438.25 304.063 437.078 302.891 437.859 303.281C439.031 304.063 443.328 304.844 449.187 307.188C451.921 307.969 454.265 309.141 455.046 313.828C456.609 320.469 464.421 350.938 467.156 369.688L468.328 385.313L447.977 371.026C443.68 353.057 435.867 327.667 433.914 323.76C431.57 321.026 423.758 320.245 419.461 319.463C416.336 319.073 413.992 317.12 412.43 312.042C412.43 308.135 411.649 301.495 410.086 292.51C408.914 285.088 408.914 281.182 408.914 277.276C408.914 272.198 406.57 270.245 400.32 263.995L397.977 259.307C391.336 246.807 390.945 244.854 387.039 244.073C385.376 244.024 384.994 238.473 383.562 235.313C383.562 234.141 384.734 231.016 383.562 225.156L368.288 212.656C361.648 212.266 357.352 225.825 353.445 232.466L348.367 244.966L342.899 261.372L341.727 263.326L340.555 266.06L330.008 281.294L326.102 287.544L324.93 289.107L317.117 299.263L308.524 309.029L291.727 327.779L287.039 334.029L284.305 335.982L270.242 352.779L267.508 355.513L265.555 358.638L264.383 359.81L256.18 368.404L248.367 375.044L246.805 376.607L241.336 380.904C238.602 384.029 231.57 384.531 228.055 384.531C225.71 382.578 216.248 381.938 217.508 379.62L226.883 372.588L228.836 371.026L234.695 364.776L237.039 362.432L242.508 357.354C247.195 352.667 251.102 349.151 253.055 340.948C254.227 336.651 264.383 326.104 268.289 321.807L269.07 321.417L295.242 293.682L315.273 261.372L318.397 253.56C320.35 249.654 320.741 247.086 321.522 244.464C322.013 242.815 326.6 216.563 324.93 212.656C323.26 208.75 332.088 195.551 326.209 189.721C323.866 187.768 320.35 185.815 318.397 183.862C313.507 178.972 300.038 175.659 301.6 169.409L300.711 159.81C303.445 148.482 306.57 135.982 303.445 135.982C301.492 135.982 290.945 149.654 286.258 155.513L285.086 156.685C276.883 168.013 266.336 177.779 258.133 191.841L242.899 218.404L237.039 226.997C235.476 228.281 229.617 232.188 227.663 232.188C221.804 228.281 222.586 225.825 217.508 234.419L203.055 260.201L201.492 264.107L200.711 265.279L197.977 270.357L196.414 273.872L182.742 296.919L173.758 314.107L170.242 319.185L168.68 321.919L167.117 323.984L163.992 327.779C163.958 327.968 156.476 332.069 155.399 331.797C154.321 331.525 148.835 329.953 147.586 327.779C146.337 325.605 148.281 323.835 149.149 322.7C154.227 316.06 153.445 310.313 153.445 308.359C153.445 306.406 151.492 298.594 151.492 296.641C151.492 294.688 151.102 294.688 151.492 284.922C152.274 273.594 143.289 274.654 144.852 265.279C145.633 259.029 146.414 251.216 143.289 253.56C141.727 253.56 129.617 266.841 124.149 273.482L114.774 285.982L99.5392 305.122L96.0236 308.247L90.5548 313.716L87.4298 315.669C84.6954 319.966 77.2736 323.091 73.3673 329.732L67.1173 340.279L64.7736 344.966L61.6486 349.654L60.4767 350.826L57.7423 355.513L55.3986 358.247L42.1173 375.826L35.0861 383.247C33.7739 384.117 33.1434 384.48 32.3517 384.531C31.5599 384.582 32.3525 374.383 32.3525 374.383L33.1329 370.859L33.9142 369.185C36.6486 363.325 41.3361 357.076 46.0236 350.826C51.1017 343.404 57.3517 329.732 63.6017 320.747L68.6798 316.06L75.3204 308.247C78.0548 306.294 81.9611 301.997 86.2579 296.529L87.8204 295.357L94.8517 286.763C100.711 278.56 116.727 261.372 126.492 251.997L128.055 249.766L130.789 247.31C137.43 241.451 143.68 233.247 148.758 233.247C156.961 233.638 162.43 240.279 167.117 244.966L184.305 261.372C185.867 262.935 187.43 262.154 188.211 260.591C200.32 237.935 210.867 216.841 219.461 216.06H226.492L229.617 213.716C236.258 202.779 244.07 187.935 250.711 178.169C258.524 167.622 283.914 134.81 298.758 121.138C302.274 117.232 305.008 115.781 307.742 115C311.649 115 315.555 116.841 319.07 119.575C333.524 131.685 356.961 157.857 366.336 168.404L372.195 173.091L387.039 181.294L390.556 185.313L392.899 189.107Z";

// Brand palette, dark-first with the light scheme as the media override.
// Backgrounds are black/white; element neutrals are cream on dark and charcoal
// on light, and never cross over.
const STYLE = `
:root {
  color-scheme: dark light;
  --bg: #191614;
  --ink: #f7ead5;
  --ink-dim: #a89f91;
  --ink-faint: #787166;
  --rule: #3a332c;
  --accent: #e98428;
  --accent-dim: #bf6b20;
  --ok: #7b9974;
  --gap: 4rem;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --ink: #2b2627;
    --ink-dim: #5c5555;
    --ink-faint: #8a827f;
    --rule: #e2dad0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 3rem;
  background: var(--bg);
  color: var(--ink);
  font-family: "Red Hat Display", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--gap);
  max-width: 56rem;
  animation: rise 500ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
canvas { width: 22rem; height: 15rem; display: block; }
/* One left edge for the whole column: every row starts on it. */
.detail { display: grid; justify-items: start; gap: 0; max-width: 26rem; }
.wordmark {
  margin: 0;
  font-size: 1.375rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.status {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 1.75rem 0 0;
  font-family: "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--tone); }
h1 {
  margin: 0.875rem 0 0;
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
p.body { margin: 0.875rem 0 0; color: var(--ink-dim); line-height: 1.65; }
hr { width: 100%; margin: 2rem 0 0; border: 0; border-top: 1px solid var(--rule); }
footer {
  margin-top: 0.875rem;
  font-family: "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.75rem;
}
footer a {
  color: var(--ink-dim);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
footer a:hover {
  color: var(--ink);
  border-bottom-color: var(--rule);
}
footer .sep { color: var(--rule); }
@keyframes rise {
  from { opacity: 0; transform: translateY(0.5rem); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  main { animation: none; }
}
@media (max-width: 46rem) {
  main { grid-template-columns: 1fr; gap: 2rem; justify-items: start; }
  canvas { width: 100%; max-width: 22rem; }
}
`;

/**
 * The mark, dithered. An offscreen fill of the path is the coverage mask; each
 * 4px cell then thresholds a travelling sine against an ordered Bayer matrix,
 * so the body shades in steps rather than gradients — the same trade the
 * terminal makes with block characters, made in pixels.
 *
 * The timeline matches Corbits Code's `markFrame`: draw left to right, hold,
 * fill bottom-up, hold, fade, loop. Reduced motion resolves to the still,
 * filled mark.
 */
const SCRIPT = `
const CELL = 4;
const PERIOD = 4.6;
const BAYER = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
const canvas = document.querySelector("canvas");
const ctx = canvas.getContext("2d");
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const path = new Path2D(canvas.dataset.path);
let cols = 0, rows = 0, mask = null;

const smooth = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

function frame(seconds) {
  if (still) return { draw: 1, fill: 1, alpha: 1 };
  const p = ((seconds % PERIOD) + PERIOD) % PERIOD / PERIOD;
  if (p < 0.38) return { draw: smooth(p / 0.38), fill: 0, alpha: 1 };
  if (p < 0.48) return { draw: 1, fill: 0, alpha: 1 };
  if (p < 0.76) return { draw: 1, fill: smooth((p - 0.48) / 0.28), alpha: 1 };
  if (p < 0.9) return { draw: 1, fill: 1, alpha: 1 };
  return { draw: 1, fill: 1, alpha: smooth((1 - p) / 0.1) };
}

// Coverage per cell, sampled once per size: fill the path into a buffer one
// pixel per cell and read back its alpha.
function measure() {
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.round(box.width);
  canvas.height = Math.round(box.height);
  cols = Math.ceil(canvas.width / CELL);
  rows = Math.ceil(canvas.height / CELL);
  const buffer = document.createElement("canvas");
  buffer.width = cols;
  buffer.height = rows;
  const bctx = buffer.getContext("2d");
  // 92% centred fit of the mark's own bounds inside the cell grid.
  const scale = Math.min(cols / 500, rows / 500) * (500 / 437) * 0.92;
  bctx.translate((cols - 437 * scale) / 2 - 32 * scale, (rows - 270 * scale) / 2 - 115 * scale);
  bctx.scale(scale, scale);
  bctx.fillStyle = "#fff";
  bctx.fill(path);
  mask = bctx.getImageData(0, 0, cols, rows).data;
}

function paint(nowMs) {
  const { draw, fill, alpha } = frame(nowMs / 1000);
  const ink = getComputedStyle(canvas).getPropertyValue("--accent").trim();
  const revealed = draw * cols;
  const fillLine = rows * (1 - fill);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  for (let row = 0; row < rows; row++) {
    // 1 once the row is wholly below the fill line, 0 once wholly above it.
    const rowFill = Math.min(1, Math.max(0, row + 1 - fillLine));
    for (let col = 0; col < cols; col++) {
      if (col >= revealed) break;
      const coverage = mask[(row * cols + col) * 4 + 3] / 255;
      if (coverage === 0) continue;
      // A travelling sine gives the body its shimmer; the edge of the reveal
      // and the fill line ride the same ramp so neither lands as a hard cut.
      const wave = 0.5 + 0.5 * Math.sin(col * 0.18 - nowMs / 520 + row * 0.12);
      const edge = Math.min(1, revealed - col);
      const value = coverage * alpha * edge * (0.45 + 0.55 * rowFill) * (0.55 + 0.45 * wave);
      if (value * 16 <= BAYER[(row % 4) * 4 + (col % 4)]) continue;
      ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
    }
  }
}

function loop(nowMs) {
  paint(nowMs);
  if (!still) requestAnimationFrame(loop);
}

measure();
requestAnimationFrame(loop);
window.addEventListener("resize", () => { measure(); if (still) paint(0); });
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * OAuth error codes arrive as machine identifiers (`access_denied`). Nothing
 * on this page is addressed to a machine, so the underscores and hyphens come
 * out and the first word is capitalized. Subjects are not run through this:
 * the host passes a display label, not an identifier.
 */
export function humanizeIdentifier(raw: string): string {
  const words = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (words.length === 0) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A footer link, preceded by its separator.
 *
 * Opens in a new tab so the operator keeps the tab telling them the
 * authorization finished and this window is safe to close.
 */
function footerLink(url: string, label: string): string {
  return `<span class="sep" aria-hidden="true">·</span><a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export interface CallbackPage {
  /** What was being authorized: the provider's display label. */
  readonly subject?: string;
  /** Why it failed. Omit for the success page. */
  readonly error?: string;
  /** Authorization succeeded, but the native setup flow still has work to do. */
  readonly pendingSetup?: boolean;
}

/**
 * Render the callback page.
 *
 * The subject leads the headline rather than sitting in a subclause: an
 * operator authorizing several servers ends up with several of these tabs
 * open, and the one thing each has to answer is which server it is and
 * whether that one worked.
 */
export function callbackPageHtml(
  page: CallbackPage = {},
  copy: CallbackPageCopy,
): string {
  const failed = page.error !== undefined;
  const subject =
    page.subject === undefined
      ? undefined
      : escapeHtml(page.subject);
  const pendingSetup = !failed && page.pendingSetup === true;
  const tone = failed ? "var(--accent)" : "var(--ok)";
  const label = failed
    ? "not connected"
    : pendingSetup
      ? "authorization received"
      : "connected";
  const heading = failed
    ? subject === undefined
      ? "Authorization did not complete"
      : `${subject} failed to connect`
    : pendingSetup
      ? subject === undefined
        ? "Authorization received"
        : `${subject} authorization received`
      : subject === undefined
        ? "Authorization complete"
        : `${subject} connected successfully`;
  const reason = escapeHtml(humanizeIdentifier(page.error ?? ""));
  const body = failed
    ? `${reason}. Close this tab and try again from ${copy.productName}.`
    : pendingSetup
      ? `Return to ${copy.productName} to finish setup.`
      : `You can close this tab and return to ${copy.productName}.`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(heading)} \u00b7 ${copy.productName}</title>`,
    `<style>${STYLE}</style>`,
    "<body><main>",
    `<canvas aria-hidden="true" data-path="${MARK_PATH}"></canvas>`,
    '<div class="detail">',
    `<p class="wordmark">${escapeHtml(copy.productName)}</p>`,
    `<p class="status" style="--tone:${tone}"><span class="dot"></span>${label}</p>`,
    `<h1>${heading}</h1>`,
    `<p class="body">${body}</p>`,
    "<hr>",
    `<footer>${copy.productName}${footerLink(copy.siteUrl, copy.siteLabel)}${footerLink(copy.githubUrl, copy.githubLabel)}</footer>`,
    "</div>",
    "</main></body>",
    `<script>${SCRIPT}</script>`,
    "</html>",
  ].join("");
}

export function authorizationDoneHtml(
  providerName: string,
  copy: CallbackPageCopy,
): string {
  return callbackPageHtml({ subject: providerName, pendingSetup: true }, copy);
}
