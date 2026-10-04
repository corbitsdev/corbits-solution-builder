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
 * Not a rendering of the .pptx bytes: a recorded deck is not re-read here.
 * Pictures the deck already holds -- the approved mockup's screens (#227) --
 * are shown where the renderer puts them; illustrations drawn only at save
 * time with an image credential are not, and the caption says so.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playerKeyAction, previewKeyAction } from "./slide-keys.ts";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { lookOf, type Deck, type DeckLook, DECISION_SLIDE_TITLE } from "@solutions-builder/app/deck";
import { toBase64 } from "./base64.ts";

export type PreviewSlide =
  | { readonly kind: "cover"; readonly title: string; readonly subtitle: string; readonly note: string; readonly image?: Uint8Array }
  | { readonly kind: "item"; readonly title: string; readonly lines: readonly string[]; readonly page: number; readonly image?: Uint8Array };

/** The renderer's cover line, verbatim, so the preview and the file agree. */
export const COVER_NOTE = "The cost and time figures in this document are placeholders.";

/** The slides in the order `renderDeck` writes them, with the page each footer carries. */
export function previewSlides(deck: Deck): PreviewSlide[] {
  const picture = (key: string): { image: Uint8Array } | {} => {
    const image = deck.images?.get(key);
    return image ? { image } : {};
  };
  const slides: PreviewSlide[] = [
    {
      kind: "cover",
      title: deck.projectTitle,
      subtitle: `Prepared for ${deck.audience} · ${deck.role}`,
      note: COVER_NOTE,
      ...picture("cover"),
    },
  ];
  deck.slides.forEach((entry, index) => {
    slides.push({ kind: "item", title: entry.title, lines: entry.bullets, page: index + 2, ...picture(String(index)) });
  });
  if (deck.decision.length > 0) {
    slides.push({ kind: "item", title: DECISION_SLIDE_TITLE, lines: deck.decision, page: deck.slides.length + 2 });
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

/** Whether an item slide is its picture: no lines to show beside it, so the picture fills the width (#252). */
export function isShowcase(slide: PreviewSlide): boolean {
  return slide.kind === "item" && slide.lines.length === 0 && slide.image !== undefined;
}

/** A slide's picture as the renderer places it: the right-hand column, fitted, or the full width on a showcase slide. */
function Picture({ image, alt, showcase = false }: { image: Uint8Array; alt: string; showcase?: boolean }) {
  return <img className={showcase ? "slide-picture showcase" : "slide-picture"} alt={alt} src={`data:image/png;base64,${toBase64(image)}`} />;
}

function Slide({ slide, footer, look }: { slide: PreviewSlide; footer: string; look: DeckLook }) {
  if (slide.kind === "cover") {
    return (
      <div className="slide slide-cover" style={slideStyle(look)}>
        <span className="slide-accent-bar" />
        <div className={slide.image ? "slide-cover-text with-picture" : "slide-cover-text"}>
          <p className="slide-cover-title">{slide.title}</p>
          <p className="slide-cover-subtitle">{slide.subtitle}</p>
          <p className="slide-cover-note">{slide.note}</p>
        </div>
        {slide.image ? <Picture image={slide.image} alt="A screen of the approved design" /> : null}
      </div>
    );
  }
  return (
    <div className="slide slide-item" style={slideStyle(look)}>
      <p className="slide-item-title">{slide.title}</p>
      <span className="slide-rule" />
      {slide.image ? <Picture image={slide.image} alt="A screen of the approved design" showcase={isShowcase(slide)} /> : null}
      <ul className={slide.image ? "slide-lines with-picture" : "slide-lines"}>
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
  // The player (#662): the slides large, one at a time, in a layer over
  // the page. Opened from the strip or the main slide; keys and a click
  // outside close it.
  const [playing, setPlaying] = useState(false);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const playerRef = useRef<HTMLDivElement>(null);
  const select = (next: number, focusThumb = false) => {
    setCurrent(next);
    if (focusThumb) thumbs.current[next]?.focus();
  };
  useEffect(() => {
    if (!playing) return;
    playerRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const action = playerKeyAction(event.key, index, slides.length);
      if (!action) return;
      event.preventDefault();
      if (action.kind === "close") setPlaying(false);
      else if (action.kind === "move") setCurrent(action.index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, index, slides.length]);

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
      <div
        className="slide-stage"
        role="button"
        tabIndex={0}
        aria-label="Play the slides"
        title="Play the slides"
        onClick={() => setPlaying(true)}
        onKeyDown={(event) => {
          const action = previewKeyAction(event.key, index, slides.length);
          if (!action) return;
          event.preventDefault();
          if (action.kind === "play") setPlaying(true);
          else if (action.kind === "move") select(action.index);
        }}
      >
        <Slide slide={shown} footer={footer} look={look} />
      </div>
      <div
        className="slide-strip"
        role="list"
        aria-label="All slides"
        onKeyDown={(event) => {
          // Left and Right change the slide and carry focus with it; Space
          // or Enter plays. A thumb's own click still selects it.
          const action = previewKeyAction(event.key, index, slides.length);
          if (!action) return;
          event.preventDefault();
          if (action.kind === "play") setPlaying(true);
          else if (action.kind === "move") select(action.index, true);
        }}
      >
        {slides.map((slide, position) => (
          <button
            key={position}
            type="button"
            role="listitem"
            className="slide-thumb"
            ref={(element) => {
              thumbs.current[position] = element;
            }}
            aria-label={`Slide ${position + 1}: ${slide.title}`}
            aria-current={position === index ? "true" : undefined}
            onClick={() => select(position)}
          >
            <Slide slide={slide} footer={footer} look={look} />
          </button>
        ))}
      </div>
      {note ? <p className="inline-note">{note}</p> : null}
      {playing && typeof document !== "undefined"
        ? // Through a portal on the body (#664): the document pane's
          // containment would otherwise pin this fixed layer to the pane.
          createPortal(
        <div
          ref={playerRef}
          className="slide-player"
          role="dialog"
          aria-modal="true"
          aria-label="Slides"
          tabIndex={-1}
          onClick={(event) => {
            if (event.target === event.currentTarget) setPlaying(false);
          }}
        >
          <div className="slide-player-head">
            <span className="slide-player-count" aria-live="polite">
              {index + 1} / {slides.length}
            </span>
            <button type="button" className="iconbtn slide-player-close" aria-label="Close the slides" onClick={() => setPlaying(false)}>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className={look.wide ? "slide-player-stage wide" : "slide-player-stage"}>
            <Slide slide={shown} footer={footer} look={look} />
          </div>
          <div className="slide-player-nav">
            <button type="button" className="iconbtn" aria-label="Previous slide" disabled={index === 0} onClick={() => setCurrent(index - 1)}>
              <ChevronLeft aria-hidden="true" />
            </button>
            <button type="button" className="iconbtn" aria-label="Next slide" disabled={index === slides.length - 1} onClick={() => setCurrent(index + 1)}>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        </div>,
            document.body,
          )
        : null}
    </section>
  );
}
