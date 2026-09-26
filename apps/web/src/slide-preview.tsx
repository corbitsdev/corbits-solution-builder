/**
 * A stakeholder's slides, on screen before they are saved (#95).
 *
 * The deck a person downloads is drawn by `renderDeck` in
 * `@solutions-builder/app/deck`: a cover, one slide per outline item, and a
 * decision slide when the package asks for one. This draws the same model
 * the same way in HTML — same order, same text, same look — so what is on
 * screen is what the file would hold. Everything is laid out in container
 * width units against the renderer's ten-inch slide, which is what lets one
 * component be the large slide and every thumbnail beneath it.
 *
 * Not a rendering of the .pptx bytes: a recorded deck is not re-read here,
 * and pictures, which are drawn only at save time with an image credential,
 * are not shown. The caption says so where it applies.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { lookOf, type Deck, type DeckLook } from "@solutions-builder/app/deck";

export type PreviewSlide =
  | { readonly kind: "cover"; readonly title: string; readonly subtitle: string; readonly note: string }
  | { readonly kind: "item"; readonly title: string; readonly lines: readonly string[]; readonly page: number };

/** The renderer's cover line, verbatim, so the preview and the file agree. */
export const COVER_NOTE = "Is this worth pursuing? Rough figures throughout; a firm estimate follows at stage 7.";

/** The slides in the order `renderDeck` writes them, with the page each footer carries. */
export function previewSlides(deck: Deck): PreviewSlide[] {
  const slides: PreviewSlide[] = [
    {
      kind: "cover",
      title: deck.projectTitle,
      subtitle: `Prepared for ${deck.audience} · ${deck.role}`,
      note: COVER_NOTE,
    },
  ];
  deck.slides.forEach((entry, index) => {
    slides.push({ kind: "item", title: entry.title, lines: entry.bullets, page: index + 2 });
  });
  if (deck.decision.length > 0) {
    slides.push({ kind: "item", title: "Decision request", lines: deck.decision, page: deck.slides.length + 2 });
  }
  return slides;
}

function slideStyle(look: DeckLook): Record<string, string> {
  return {
    "--slide-accent": `#${look.accent}`,
    "--slide-ink": `#${look.ink}`,
    "--slide-paper": `#${look.paper}`,
    "--slide-muted": `#${look.muted}`,
    "--slide-title-face": look.titleFace,
    "--slide-body-face": look.bodyFace,
    // The renderer's slide height, in the same width units the layout uses.
    "--slide-h": look.wide ? "56.25cqw" : "75cqw",
    aspectRatio: look.wide ? "16 / 9" : "4 / 3",
  };
}

function Slide({ slide, footer, look }: { slide: PreviewSlide; footer: string; look: DeckLook }) {
  if (slide.kind === "cover") {
    return (
      <div className="slide slide-cover" style={slideStyle(look)}>
        <span className="slide-accent-bar" />
        <div className="slide-cover-text">
          <p className="slide-cover-title">{slide.title}</p>
          <p className="slide-cover-subtitle">{slide.subtitle}</p>
          <p className="slide-cover-note">{slide.note}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="slide slide-item" style={slideStyle(look)}>
      <p className="slide-item-title">{slide.title}</p>
      <span className="slide-rule" />
      <ul className="slide-lines">
        {slide.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      <p className="slide-footer">
        {footer} · {slide.page}
      </p>
    </div>
  );
}

export function SlidePreview({ deck, note }: { deck: Deck; note?: string | null }) {
  const slides = previewSlides(deck);
  const look = lookOf(deck.design, deck.theme);
  const footer = `${deck.projectTitle} · for ${deck.audience}`;
  // Opens on the cover. A different package is a different key in the page
  // that mounts this, which is what puts a switch of stakeholder back on
  // theirs; a deck rebuilt for the same package keeps the slide in view.
  const [current, setCurrent] = useState(0);
  const index = Math.min(current, slides.length - 1);
  const shown = slides[index]!;

  return (
    <section className="slide-preview" aria-label="Slides preview">
      <div className="slide-preview-head">
        <p className="slide-preview-title">Slides</p>
        <p className="slide-preview-count" aria-live="polite">
          Slide {index + 1} of {slides.length}
        </p>
        <div className="slide-preview-nav">
          <button
            type="button"
            className="iconbtn"
            aria-label="Previous slide"
            disabled={index === 0}
            onClick={() => setCurrent(index - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="iconbtn"
            aria-label="Next slide"
            disabled={index === slides.length - 1}
            onClick={() => setCurrent(index + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="slide-stage">
        <Slide slide={shown} footer={footer} look={look} />
      </div>
      <div className="slide-strip" role="list" aria-label="All slides">
        {slides.map((slide, position) => (
          <button
            key={position}
            type="button"
            role="listitem"
            className="slide-thumb"
            aria-label={`Slide ${position + 1}: ${slide.title}`}
            aria-current={position === index ? "true" : undefined}
            onClick={() => setCurrent(position)}
          >
            <Slide slide={slide} footer={footer} look={look} />
          </button>
        ))}
      </div>
      {note ? <p className="inline-note">{note}</p> : null}
    </section>
  );
}
