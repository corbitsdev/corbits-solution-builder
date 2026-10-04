/**
 * A stakeholder's slides as one printable HTML document (#232): one page
 * per slide at the renderer's proportions, drawn the way `SlidePreview`
 * draws them, pictures included. Printed through the system print dialog
 * (`print.tsx`), which is how a page becomes a PDF on every platform.
 * Pure: a string in, a string out, so what goes to the printer is testable.
 */
import { lookOf, type Deck } from "@solutions-builder/app/deck";
import { toBase64 } from "./base64.ts";
import { COVER_NOTE, isShowcase, previewSlides, previewTextScale } from "./slide-preview.tsx";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The page: 10in wide, 5.625in or 7.5in tall, matching the renderer's slide. */
export function slidesPrintHtml(deck: Deck, title: string): string {
  const look = lookOf(deck.design, deck.theme);
  const height = look.wide ? 5.625 : 7.5;
  const footer = `${deck.projectTitle} · for ${deck.audience}`;
  const picture = (image: Uint8Array | undefined, kind: "cover" | "item" | "showcase") =>
    image ? `<img class="picture${kind === "cover" ? " cover-picture" : kind === "showcase" ? " showcase" : ""}" alt="" src="data:image/png;base64,${toBase64(image)}" />` : "";
  const pages = previewSlides(deck).map((slide) => {
    if (slide.kind === "cover") {
      return `<section class="slide cover"><span class="bar"></span><div class="cover-text${slide.image ? " with-picture" : ""}"><h1>${escapeHtml(slide.title)}</h1><p class="subtitle">${escapeHtml(slide.subtitle)}</p><p class="note">${escapeHtml(COVER_NOTE)}</p></div>${picture(slide.image, "cover")}</section>`;
    }
    const lines = slide.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
    return `<section class="slide item"><h2>${escapeHtml(slide.title)}</h2><span class="rule"></span>${picture(slide.image, isShowcase(slide) ? "showcase" : "item")}<ul class="lines${slide.image ? " with-picture" : ""}" style="--slide-text-scale:${String(previewTextScale(slide, look))}">${lines}</ul><p class="footer">${escapeHtml(footer)} · ${String(slide.page)}</p></section>`;
  });
  const css = `
    @page { size: 10in ${String(height)}in; margin: 0; }
    html, body { margin: 0; padding: 0; background: #${look.paper}; }
    body { font-family: "${look.bodyFace}", sans-serif; color: #${look.ink}; }
    .slide { position: relative; width: 10in; height: ${String(height)}in; overflow: hidden; page-break-after: always; break-after: page; background: #${look.paper}; }
    .slide:last-child { page-break-after: auto; break-after: auto; }
    .bar { position: absolute; left: 0; top: 0; width: 0.25in; height: 100%; background: #${look.accent}; }
    .cover-text { position: absolute; left: 0.7in; top: 25%; width: 8.6in; }
    .cover-text.with-picture { width: 5in; }
    h1 { margin: 0; font: bold 32pt "${look.titleFace}", serif; line-height: 1.15; }
    .subtitle { margin: 0.2in 0 0; font-size: 16pt; color: #${look.muted}; }
    .note { margin: 0.35in 0 0; font-size: 12pt; color: #${look.muted}; }
    h2 { position: absolute; left: 0.5in; top: 0.35in; width: 9in; margin: 0; font: bold 24pt "${look.titleFace}", serif; }
    .rule { position: absolute; left: 0.5in; top: 1.3in; width: 9in; border-top: 1.5pt solid #${look.accent}; }
    .lines { position: absolute; left: 0.5in; top: 1.5in; width: 9in; height: calc(100% - 2.2in); margin: 0; padding-left: 0.3in; font-size: calc(15pt * var(--slide-text-scale, 1)); line-height: 1.3; overflow: hidden; }
    .lines.with-picture { width: 5.4in; }
    .lines li { margin-bottom: calc(6pt * var(--slide-text-scale, 1)); }
    .picture { position: absolute; left: 6.2in; top: 1.5in; width: 3.4in; height: calc(100% - 2.2in); object-fit: contain; object-position: center; }
    .cover-picture { left: 5.8in; top: 0.6in; width: 3.8in; height: calc(100% - 1.2in); }
    .picture.showcase { left: 0.5in; width: 9in; }
    .footer { position: absolute; left: 0.5in; bottom: 0.2in; width: 9in; margin: 0; font-size: 9pt; color: #${look.muted}; }
  `;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${pages.join("")}</body></html>`;
}
