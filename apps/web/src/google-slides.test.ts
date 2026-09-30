import { describe, expect, test } from "bun:test";
import { ApiFailure } from "./client.js";
import { GOOGLE_SLIDES_HOME, base64Of, notConnected, openInGoogleSlides, type GoogleSlidesDeps } from "./google-slides.ts";

const PPTX = { dataUrl: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,UEsDBA==", filename: "Inteva Complete - Mr Finance.pptx" };

function deps(upload: GoogleSlidesDeps["upload"]) {
  const shown: string[] = [];
  const saved: string[] = [];
  const d: GoogleSlidesDeps = {
    upload,
    download: (_dataUrl, filename) => saved.push(filename),
    show: (_tab, url) => shown.push(url),
  };
  return { d, shown, saved };
}

// #233: one click to Google Slides through the host's Drive connection.
describe("openInGoogleSlides", () => {
  test("uploads the PowerPoint's bytes under the deck's name and sends the tab to the document", async () => {
    const asked: { name: string; pptxBase64: string }[] = [];
    const { d, shown, saved } = deps(async (slides) => {
      asked.push(slides);
      return { url: "https://docs.google.com/presentation/d/doc-1/edit" };
    });
    const result = await openInGoogleSlides(PPTX, "Inteva Complete - Mr Finance", null, d);
    expect(asked).toEqual([{ name: "Inteva Complete - Mr Finance", pptxBase64: "UEsDBA==" }]);
    expect(shown).toEqual(["https://docs.google.com/presentation/d/doc-1/edit"]);
    expect(saved).toEqual([]);
    expect(result).toEqual({ url: "https://docs.google.com/presentation/d/doc-1/edit", notice: null });
  });

  test("without a connection the PowerPoint is saved, Slides opened for the import, and the notice says where to connect", async () => {
    const refusal = new ApiFailure({ code: "not_connected", message: "Google Drive is not connected.", correlationId: "-", retryable: false }, 409);
    const { d, shown, saved } = deps(async () => {
      throw refusal;
    });
    const result = await openInGoogleSlides(PPTX, "Deck", null, d);
    expect(notConnected(refusal)).toBe(true);
    expect(saved).toEqual([PPTX.filename]);
    expect(shown).toEqual([GOOGLE_SLIDES_HOME]);
    expect(result.url).toBeNull();
    expect(result.notice).toContain("Google Drive is not connected");
    expect(result.notice).toContain(PPTX.filename);
    expect(result.notice).toContain("Settings");
  });

  test("any other failure is the caller's to report, and nothing is saved or opened", async () => {
    const { d, shown, saved } = deps(async () => {
      throw new ApiFailure({ code: "google_upload_failed", message: "Google Drive refused the upload: quota", correlationId: "-", retryable: false }, 502);
    });
    await expect(openInGoogleSlides(PPTX, "Deck", null, d)).rejects.toThrow(/quota/);
    expect(saved).toEqual([]);
    expect(shown).toEqual([]);
  });

  test("a text body is not a PowerPoint", () => {
    expect(base64Of(PPTX.dataUrl)).toBe("UEsDBA==");
    expect(() => base64Of("## Package\n")).toThrow(/not a PowerPoint/);
  });
});
