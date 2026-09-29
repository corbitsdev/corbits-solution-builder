/**
 * The design documents of one scope, listed and managed (#246): the
 * workspace's, from Settings, or one project's own, from the project's
 * settings dialog. Each row names the file and says what is read from it —
 * text as written, a PDF's text, a PowerPoint's text and theme — and a
 * binary file nothing could be read from says so rather than sitting in
 * the list as if it were consulted.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../client.js";
import { Banner, Button } from "../components.jsx";
import { DESIGN_DOCUMENT_ACCEPT, whatIsRead, type DeckDesignDocument, type DesignDocumentFormat } from "../deck-design-documents.ts";

export function formatLabel(format: DesignDocumentFormat): string {
  switch (format) {
    case "text":
      return "Text";
    case "pdf":
      return "PDF";
    case "pptx":
      return "PowerPoint";
  }
}

/** The row's second line: what this document contributes, or that it could not be read. */
export function documentNote(document: Pick<DeckDesignDocument, "format" | "readingId" | "theme" | "textRead">): string {
  const look = document.format === "pdf" ? "its page size and colours" : "its theme";
  if (document.readingId === null || !document.textRead) {
    if (document.theme) {
      return `No text could be read from it (pictures only), so the presentation creator is not handed any; ${look} still draw${document.format === "pdf" ? "" : "s"} the slides.`;
    }
    return "Kept, but nothing could be read from it, so it is not consulted.";
  }
  if (document.format === "pptx" && !document.theme) {
    return "Its slides' text is handed to the presentation creator. It carries no theme to draw the slides with.";
  }
  if (document.format === "pdf" && !document.theme) {
    return "Its text is handed to the presentation creator. No page size or colours could be read from it.";
  }
  return whatIsRead(document.format);
}

export function DesignDocumentsList({
  projectId,
  emptyNote,
}: {
  /** Absent for the workspace's documents. */
  projectId?: string;
  emptyNote: string;
}) {
  const [documents, setDocuments] = useState<DeckDesignDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    const result = await api.designDocuments(projectId);
    setDocuments(result.documents);
  };
  useEffect(() => {
    let cancelled = false;
    void api
      .designDocuments(projectId)
      .then((result) => {
        if (!cancelled) setDocuments(result.documents);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const add = async (files: FileList) => {
    if (files.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      await api.addDesignDocuments([...files], projectId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setAdding(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async (document: DeckDesignDocument) => {
    setRemoving((before) => new Set(before).add(document.id));
    setError(null);
    try {
      await api.removeDesignDocument(document.id, projectId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setRemoving((before) => {
        const next = new Set(before);
        next.delete(document.id);
        return next;
      });
    }
  };

  return (
    <div className="design-docs">
      {error ? <Banner tone="error" title={error} /> : null}
      {documents === null && !error ? <p className="inline-note">Loading…</p> : null}
      {documents?.length === 0 ? <p className="inline-note">{emptyNote}</p> : null}
      {documents && documents.length > 0 ? (
        <ul className="design-docs-list">
          {documents.map((document) => (
            <li key={document.id}>
              <div className="design-doc-k">
                <b>{document.name}</b>
                <span>
                  {formatLabel(document.format)} · {documentNote(document)}
                </span>
              </div>
              <Button variant="ghost" loading={removing.has(document.id)} onClick={() => void remove(document)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={DESIGN_DOCUMENT_ACCEPT}
        aria-label="Choose design guidelines or presentations to add"
        onChange={(event) => {
          if (event.target.files) void add(event.target.files);
        }}
      />
      <Button variant="link" loading={adding} disabled={documents === null} onClick={() => input.current?.click()}>
        Add design documents…
      </Button>
      <p className="inline-note">Text or Markdown guidelines, or an existing presentation as PowerPoint or PDF.</p>
    </div>
  );
}
