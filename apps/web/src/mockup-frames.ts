/**
 * A screen drawn inside the body it belongs to (#654): a phone screen in
 * a rounded dark handset with the island at the top and the home indicator
 * at the bottom; a desktop screen in a browser window with its title bar,
 * three dots and an address pill. `frameGeometry` is pure and sized from
 * the screen; `frameMockup` draws it on a canvas, in the browser.
 */
import { mockupShots, type MockupShot, type ScreenKind } from "./mockup-shots.ts";

export type FrameGeometry = {
  readonly kind: ScreenKind;
  readonly width: number;
  readonly height: number;
  /** Where the screen sits inside the body. */
  readonly screen: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number };
  readonly bodyRadius: number;
};

/** A phone's screen is this many times taller than wide (the 402 x 874 point screen the designer lays out for). */
export const PHONE_SCREEN_RATIO = 874 / 402;

/**
 * The body around a screen of the given size, in the picture's own pixels
 * (the screen is captured at 2x). A phone's screen is the phone's, not the
 * page's (#670): its height follows the device, and the capture is
 * clipped to it, so a long page never stretches the handset.
 */
export function frameGeometry(kind: ScreenKind, screenWidth: number, screenHeight: number): FrameGeometry {
  if (kind === "phone") {
    const bezel = Math.round(screenWidth * 0.035) + 10;
    const height = Math.round(screenWidth * PHONE_SCREEN_RATIO);
    return {
      kind,
      width: screenWidth + bezel * 2,
      height: height + bezel * 2,
      screen: { x: bezel, y: bezel, width: screenWidth, height, radius: Math.round(screenWidth * 0.11) },
      bodyRadius: Math.round(screenWidth * 0.11) + bezel,
    };
  }
  const bar = Math.max(44, Math.round(screenWidth * 0.028));
  const edge = 2;
  return {
    kind,
    width: screenWidth + edge * 2,
    height: screenHeight + bar + edge,
    screen: { x: edge, y: bar, width: screenWidth, height: screenHeight, radius: 0 },
    bodyRadius: Math.max(12, Math.round(bar * 0.3)),
  };
}

/** The body a picture of this shape gets: a handset only for a portrait picture; anything landscape is a browser window. */
export function bodyFor(kind: ScreenKind, width: number, height: number): ScreenKind {
  return kind === "phone" && width > height ? "desktop" : kind;
}

/** How a framed picture is named in the README: the body it was drawn in. */
export function frameLabel(kind: ScreenKind | undefined): string {
  return kind === "phone" ? "in a phone body" : kind === "desktop" ? "in a browser window" : "as captured";
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

/** The colour of a picture's top-left pixel, as CSS, so the rest of a short page's screen matches it; null when it cannot be read. */
function backgroundOf(image: ImageBitmap): string | null {
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const context = probe.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
  } catch {
    return null;
  }
}

async function bitmapOf(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
}

/** The screen's picture inside its body, as PNG bytes; a shot with no kind is returned as it is. */
export async function frameMockup(shot: MockupShot): Promise<Uint8Array> {
  if (shot.framed || !shot.kind || typeof document === "undefined") return shot.png;
  const image = await bitmapOf(shot.png);
  const scale = shot.width && shot.width > 0 ? image.width / shot.width : 2;
  // A handset is never drawn around a landscape picture (#668): a screen
  // marked a phone's that was still captured wide gets the browser window.
  const kind = bodyFor(shot.kind, image.width, image.height);
  const geometry = frameGeometry(kind, image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  const context = canvas.getContext("2d");
  if (!context) return shot.png;
  const unit = Math.max(1, scale);
  const { screen } = geometry;

  if (kind === "phone") {
    // The handset: a dark body with a thin highlight, the screen clipped to
    // its own corners, the island and the home indicator over it.
    roundedRect(context, 0, 0, geometry.width, geometry.height, geometry.bodyRadius);
    context.fillStyle = "#111318";
    context.fill();
    context.lineWidth = unit;
    context.strokeStyle = "rgba(255,255,255,0.18)";
    context.stroke();
    context.save();
    roundedRect(context, screen.x, screen.y, screen.width, screen.height, screen.radius);
    context.clip();
    // The page from its top, at the screen's width, clipped to the screen:
    // a longer page is cut at the bottom, a shorter one sits on its own
    // background colour read from the capture's first pixel row.
    context.fillStyle = backgroundOf(image) ?? "#ffffff";
    context.fillRect(screen.x, screen.y, screen.width, screen.height);
    const drawnHeight = image.height * (screen.width / image.width);
    context.drawImage(image, screen.x, screen.y, screen.width, drawnHeight);
    context.restore();
    const islandW = Math.round(screen.width * 0.3);
    const islandH = Math.round(screen.width * 0.085);
    roundedRect(context, screen.x + (screen.width - islandW) / 2, screen.y + islandH * 0.5, islandW, islandH, islandH / 2);
    context.fillStyle = "#0b0c10";
    context.fill();
    const barW = Math.round(screen.width * 0.36);
    roundedRect(context, screen.x + (screen.width - barW) / 2, screen.y + screen.height - 5 * unit, barW, 2.5 * unit, 1.25 * unit);
    context.fillStyle = "rgba(0,0,0,0.55)";
    context.fill();
  } else {
    // The browser window: a light title bar with the three dots and an
    // address pill, a hairline edge, the page below.
    const bar = screen.y;
    roundedRect(context, 0, 0, geometry.width, geometry.height, geometry.bodyRadius);
    context.fillStyle = "#e9e9ec";
    context.fill();
    context.save();
    roundedRect(context, 0, 0, geometry.width, geometry.height, geometry.bodyRadius);
    context.clip();
    context.fillStyle = "#ffffff";
    context.fillRect(screen.x, screen.y, screen.width, screen.height);
    context.drawImage(image, screen.x, screen.y, screen.width, screen.height);
    context.restore();
    const dot = bar * 0.26;
    for (const [i, colour] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
      context.beginPath();
      context.arc(bar * 0.55 + i * dot * 1.9, bar / 2, dot / 2, 0, Math.PI * 2);
      context.fillStyle = colour;
      context.fill();
    }
    const pillX = bar * 0.55 + 3 * dot * 1.9 + bar * 0.4;
    const pillW = Math.min(geometry.width * 0.5, geometry.width - pillX - bar * 0.5);
    roundedRect(context, pillX, bar * 0.22, pillW, bar * 0.56, bar * 0.28);
    context.fillStyle = "#ffffff";
    context.fill();
    context.strokeStyle = "rgba(0,0,0,0.08)";
    context.lineWidth = unit * 0.5;
    context.stroke();
    roundedRect(context, 0.5, 0.5, geometry.width - 1, geometry.height - 1, geometry.bodyRadius);
    context.strokeStyle = "rgba(0,0,0,0.18)";
    context.lineWidth = 1;
    context.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return shot.png;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The design's screens, each inside its body (#666): what every slide,
 * preview, print and download draws. A screen whose body cannot be drawn
 * is kept bare rather than dropped.
 */
export async function framedMockupShots(html: string, max?: number): Promise<MockupShot[]> {
  const shots = await mockupShots(html, max);
  return Promise.all(
    shots.map(async (shot) => {
      const png = await frameMockup(shot).catch(() => shot.png);
      return { ...shot, png, framed: png !== shot.png || shot.framed === true };
    }),
  );
}
