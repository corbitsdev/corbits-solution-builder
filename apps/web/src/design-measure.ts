/**
 * How wide a design lays itself out (#268): the natural width of its page
 * when given a viewport of `at` pixels. Measured in a hidden same-origin
 * frame with the design's scripts removed, the way `mockup-shots.ts` draws
 * a design's screens, and the frame is gone once the number is read.
 * `fitDesignScale` is pure, so the rule the visible frame follows is
 * testable without a document.
 */

const LOAD_TIMEOUT_MS = 8_000;

/**
 * The scale that shows a design `natural` pixels wide inside `available`
 * pixels without cutting it: 1 when it already fits or nothing is known,
 * smaller when it does not, never larger — a design is never blown up.
 */
export function fitDesignScale(natural: number | null, available: number): number {
  if (natural === null || !Number.isFinite(natural) || !Number.isFinite(available) || natural <= 0 || available <= 0) return 1;
  return natural > available ? available / natural : 1;
}

/** The design's natural width at a viewport `at` wide, or null outside a browser or when it cannot be loaded. */
export async function measureDesignWidth(html: string, at: number): Promise<number | null> {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const frame = document.createElement("iframe");
  // Same-origin so the width can be read; no scripts, since a generated design is untrusted.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${String(Math.max(1, Math.round(at)))}px;height:800px;border:0;visibility:hidden`;
  frame.srcdoc = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the design took too long to load")), LOAD_TIMEOUT_MS);
      frame.onload = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return null;
    const width = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0);
    return width > 0 ? width : null;
  } catch {
    return null;
  } finally {
    frame.remove();
  }
}
