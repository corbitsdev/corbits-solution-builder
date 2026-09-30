/**
 * "Open in Google Slides" (#233): the PowerPoint goes to the host's Google
 * Drive connection, which uploads it with conversion and hands back the
 * document's link, and the tab opened on the click is sent there. Without
 * the connection, the PowerPoint is saved and Google Slides opened for a
 * manual import, with a word on where to connect. Anything else that goes
 * wrong is the caller's to report.
 */
import { api, ApiFailure } from "./client.js";
import { downloadArtifact } from "./components.jsx";

export const GOOGLE_SLIDES_HOME = "https://docs.google.com/presentation/u/0/";

export type SlidesFile = { readonly dataUrl: string; readonly filename: string };

export type GoogleSlidesDeps = {
  readonly upload: (slides: { name: string; pptxBase64: string }) => Promise<{ url: string }>;
  readonly download: (dataUrl: string, filename: string) => void;
  /** Sends `tab` to `url`, or opens a new one when the click's tab is gone. */
  readonly show: (tab: Window | null, url: string) => void;
};

const DEFAULT_DEPS: GoogleSlidesDeps = {
  upload: (slides) => api.googleDrive.uploadSlides(slides),
  download: downloadArtifact,
  show: (tab, url) => {
    if (tab && !tab.closed) tab.location.href = url;
    else window.open(url, "_blank", "noopener");
  },
};

/** The base64 payload of a `data:` URL; a text body is not a PowerPoint. */
export function base64Of(dataUrl: string): string {
  const at = dataUrl.indexOf("base64,");
  if (!dataUrl.startsWith("data:") || at === -1) throw new Error("the slides are not a PowerPoint file");
  return dataUrl.slice(at + "base64,".length);
}

/** Whether a failure is the host saying Google Drive is not connected. */
export function notConnected(cause: unknown): boolean {
  return cause instanceof ApiFailure && cause.detail.code === "not_connected";
}

export async function openInGoogleSlides(
  pptx: SlidesFile,
  name: string,
  tab: Window | null,
  deps: GoogleSlidesDeps = DEFAULT_DEPS,
): Promise<{ url: string | null; notice: string | null }> {
  const pptxBase64 = base64Of(pptx.dataUrl);
  try {
    const uploaded = await deps.upload({ name, pptxBase64 });
    deps.show(tab, uploaded.url);
    return { url: uploaded.url, notice: null };
  } catch (cause) {
    if (!notConnected(cause)) throw cause;
    deps.download(pptx.dataUrl, pptx.filename);
    deps.show(tab, GOOGLE_SLIDES_HOME);
    return {
      url: null,
      notice: `Google Drive is not connected, so the PowerPoint is saved instead. In Google Slides choose File → Import slides and pick ${pptx.filename}. Connect Google Drive under Settings for one click next time.`,
    };
  }
}
