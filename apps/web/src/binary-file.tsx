/**
 * A binary artifact in a document pane: a file to save, not text to read.
 *
 * `api.artifactContent` returns an uploaded binary's content as its `data:`
 * URL by convention, and a pane that hands that string to the markdown
 * renderer prints the URL as the document (issue #11). What a person can
 * use is what the file is, how big it is, and the download.
 */
import { useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "./client.ts";
import { Banner, Button, downloadArtifact } from "./components.tsx";

/** Whether a document's content is a `data:` URL: bytes, never prose. */
export function isDataUrl(content: string): boolean {
  return /^data:[^,]*,/i.test(content);
}

/** The media type a `data:` URL declares, or null. */
export function dataUrlMediaType(content: string): string | null {
  const match = /^data:([^;,]+)/i.exec(content);
  return match?.[1]?.toLowerCase() ?? null;
}

const KNOWN: readonly { readonly type: RegExp; readonly label: string; readonly extension: string }[] = [
  { type: /presentationml|vnd\.ms-powerpoint/, label: "PowerPoint deck", extension: "pptx" },
  { type: /spreadsheetml|vnd\.ms-excel/, label: "Excel workbook", extension: "xlsx" },
  { type: /wordprocessingml|msword/, label: "Word document", extension: "docx" },
  { type: /^application\/pdf$/, label: "PDF", extension: "pdf" },
  { type: /^application\/(?:gzip|x-gzip|x-tar)$/, label: "tar.gz archive", extension: "tar.gz" },
  { type: /^application\/zip$/, label: "zip archive", extension: "zip" },
  { type: /^image\/png$/, label: "PNG image", extension: "png" },
  { type: /^image\/jpe?g$/, label: "JPEG image", extension: "jpg" },
  { type: /^image\/gif$/, label: "GIF image", extension: "gif" },
  { type: /^image\/webp$/, label: "WebP image", extension: "webp" },
];

/** What kind of file it is, in plain words, and the extension its download gets. */
export function describeBinary(mediaType: string | null): { label: string; extension: string | null } {
  const type = mediaType?.toLowerCase() ?? "";
  const known = KNOWN.find((entry) => entry.type.test(type));
  if (known) return { label: known.label, extension: known.extension };
  return { label: "file", extension: null };
}

/** The download's name: the artifact's title, given the file's own extension once. */
export function binaryFileName(title: string, extension: string | null): string {
  const base = title.trim() || "artifact";
  if (!extension) return base;
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

export function formatBinarySize(sizeBytes: number | undefined): string | null {
  if (sizeBytes === undefined) return null;
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** The file card: what it is, how big, and the one thing to do with it. */
export function BinaryFile({ node, tenantId, content }: { node: ArtifactNode; tenantId: string; content: string | null }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const mediaType = (content && dataUrlMediaType(content)) || node.mediaType || null;
  const { label, extension } = describeBinary(mediaType);
  const size = formatBinarySize(node.sizeBytes);
  const download = async () => {
    setState({ busy: true, error: null });
    try {
      const bytes = content && isDataUrl(content) ? content : (await api.artifactContent(tenantId, node.id)).content;
      downloadArtifact(bytes, binaryFileName(node.title, extension));
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof ApiFailure ? cause.detail.message : String(cause) });
    }
  };
  return (
    <div className="deck-file binary-file">
      <p className="inline-note">
        {node.title} · {label}
        {size ? ` · ${size}` : ""}. A file, not a page: save it and open it in the app that reads it.
      </p>
      <div className="button-row">
        <Button variant="primary" loading={state.busy} onClick={() => void download()}>
          Download {extension ? `(.${extension})` : "file"}
        </Button>
      </div>
      {state.error ? <Banner tone="error" title={state.error} /> : null}
    </div>
  );
}
