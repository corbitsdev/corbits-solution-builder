import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactNode } from "./client.ts";
import { BinaryFile, binaryFileName, dataUrlMediaType, describeBinary, isDataUrl } from "./binary-file.tsx";

const PPTX = "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,UEsDBBQABgAI";

describe("binary artifacts", () => {
  test("a data: URL is bytes; markdown and HTML are not", () => {
    expect(isDataUrl(PPTX)).toBe(true);
    expect(isDataUrl("# Build plan\n\ndata: is mentioned here")).toBe(false);
    expect(isDataUrl("<!doctype html><html></html>")).toBe(false);
  });

  test("the media type comes off the URL and names the kind of file and its extension", () => {
    expect(dataUrlMediaType(PPTX)).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(describeBinary(dataUrlMediaType(PPTX))).toEqual({ label: "PowerPoint deck", extension: "pptx" });
    expect(describeBinary("application/pdf")).toEqual({ label: "PDF", extension: "pdf" });
    expect(describeBinary("application/octet-stream")).toEqual({ label: "file", extension: null });
  });

  test("the download is named for the artifact with its extension given once", () => {
    expect(binaryFileName("Slides · You", "pptx")).toBe("Slides · You.pptx");
    expect(binaryFileName("Workbook.xlsx", "xlsx")).toBe("Workbook.xlsx");
    expect(binaryFileName("  ", null)).toBe("artifact");
  });

  test("the card says what the file is and offers the download, never the URL", () => {
    const node = {
      id: "n1", kind: "audience_deck", variant: "You", stage: 5, title: "Slides · You", version: 2, artifactId: "a1",
      contentHash: "a1@2", sizeBytes: 48_000, mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      createdAt: "2026-09-24T00:00:00.000Z", supersededByNodeId: null, provenance: { producer: "agent" },
    } as ArtifactNode;
    const html = renderToStaticMarkup(createElement(BinaryFile, { node, tenantId: "tnt", content: PPTX }));
    expect(html).toContain("PowerPoint deck");
    expect(html).toContain("47 KB");
    expect(html).toContain("Download (.pptx)");
    expect(html).not.toContain("base64");
  });
});
