/**
 * A screen drawn inside the body it belongs to (#654): a phone screen in
 * a rounded dark handset with the island at the top and the home indicator
 * at the bottom; a desktop screen in a browser window with its title bar,
 * three dots and an address pill. `frameGeometry` is pure and sized from
 * the screen; `frameMockup` draws it on a canvas, in the browser.
 */
import type { MockupShot, ScreenKind } from "./mockup-shots.ts";

export type FrameGeometry = {
  readonly kind: ScreenKind;
  readonly width: number;
  readonly height: number;
  /** Where the screen sits inside the body. */
  readonly screen: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number };
  readonly bodyRadius: number;
};

/** The body around a screen of the given size, in the picture's own pixels (the screen is captured at 2x). */
export function frameGeometry(kind: ScreenKind, screenWidth: number, screenHeight: number): FrameGeometry {
  if (kind === "phone") {
    const bezel = Math.round(screenWidth * 0.035) + 10;
    return {
      kind,
      width: screenWidth + bezel * 2,
      height: screenHeight + bezel * 2,
      screen: { x: bezel, y: bezel, width: screenWidth, height: screenHeight, radius: Math.round(screenWidth * 0.11) },
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

async function bitmapOf(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
}

/** The screen's picture inside its body, as PNG bytes; a shot with no kind is returned as it is. */
export async function frameMockup(shot: MockupShot): Promise<Uint8Array> {
  if (!shot.kind || typeof document === "undefined") return shot.png;
  const image = await bitmapOf(shot.png);
  const scale = shot.width && shot.width > 0 ? image.width / shot.width : 2;
  const geometry = frameGeometry(shot.kind, image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  const context = canvas.getContext("2d");
  if (!context) return shot.png;
  const unit = Math.max(1, scale);
  const { screen } = geometry;

  if (shot.kind === "phone") {
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
    context.drawImage(image, screen.x, screen.y, screen.width, screen.height);
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
