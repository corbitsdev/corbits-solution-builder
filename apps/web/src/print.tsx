/**
 * Printing a document, or saving it as a PDF.
 *
 * A specialist's document is worth handing to someone who does not have the
 * app, and the system print dialog is how a page becomes a PDF on every
 * platform. What this owns is getting the document alone onto a page: a
 * layer over the app with only the document in it, at reading width, and a
 * bar with the two things a person can do there. In print the bar and the
 * app underneath are gone and the document is all the page carries.
 *
 * A design is one HTML document of its own and cannot be printed from inside
 * the frame the app reviews it in, so for a design the host serves the page
 * itself with the same bar, and the app goes there.
 *
 * In the desktop app `window.print()` is the shell's own print command, which
 * the capability allows; in a browser it is the browser's.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Printer } from "lucide-react";
import { api, type ArtifactNode } from "./client.js";
import { Button, documentName, stageName } from "./components.jsx";
import { Markdown } from "./markdown.jsx";

export type PrintTarget = { node: ArtifactNode; content: string | null };

let target: PrintTarget | null = null;
const listeners = new Set<() => void>();

/**
 * The open project's name, told by the app as it changes: a printed PDF is
 * saved under the page's title, and the title should name the project and
 * the document rather than the app.
 */
let projectTitle: string | null = null;
export function setPrintProject(title: string | null): void {
  projectTitle = title;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "document"
  );
}

/** `<project>-<document>`: the PDF's default file name, before the dialog adds its extension. */
export function printFileName(node: ArtifactNode): string {
  return `${slug(projectTitle ?? "project")}-${slug(documentLabel(node))}`;
}

function set(next: PrintTarget | null) {
  target = next;
  for (const listener of listeners) listener();
}

export function usePrintTarget(): PrintTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => target,
  );
}

export function closePrint(): void {
  set(null);
}

/** A design is served as a page of its own; anything else prints from here. */
function isPage(node: ArtifactNode): boolean {
  return node.mediaType === "text/html" || node.kind === "design_artifact";
}

/** Opens the document for printing. `content` may be null; it is fetched then. */
export function printArtifact(node: ArtifactNode, content: string | null = null): void {
  if (isPage(node)) {
    window.location.assign(api.printPage(node.id));
    return;
  }
  set({ node, content });
}

export function PrintButton({ node, content }: { node: ArtifactNode; content: string | null }) {
  return (
    <Button variant="ghost" onClick={() => printArtifact(node, content)}>
      <Printer aria-hidden="true" />
      Print or save as PDF
    </Button>
  );
}

function documentLabel(node: ArtifactNode): string {
  return node.variant ?? documentName(node.kind);
}

/** The layer with the document alone in it. Escape or Back returns to the app. */
export function PrintView({ target: shown }: { target: PrintTarget }) {
  const printButton = useRef<HTMLButtonElement>(null);
  const content = useFetched(shown);

  // The page's title is what the print dialog names the PDF. It is the
  // document's for as long as the layer is open, and the app's again after.
  useEffect(() => {
    const before = document.title;
    document.title = printFileName(shown.node);
    return () => {
      document.title = before;
    };
  }, [shown.node]);

  useEffect(() => {
    printButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePrint();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { node } = shown;
  const when = new Date(node.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="print-view" role="dialog" aria-modal="true" aria-label="Print or save as PDF">
      <div className="print-bar">
        <Button variant="ghost" onClick={closePrint}>
          Back to the app
        </Button>
        <button ref={printButton} type="button" className="print-now" onClick={() => window.print()}>
          <Printer aria-hidden="true" />
          Print or save as PDF
        </button>
      </div>
      <article className="print-page">
        <header className="print-head">
          <h1>{documentLabel(node)}</h1>
          <p>
            Stage {node.stage} · {stageName(node.stage)} · Version {node.version} · {when}
          </p>
        </header>
        {content === null ? (
          <p className="inline-note">Loading…</p>
        ) : content ? (
          <Markdown source={content} />
        ) : (
          <p className="inline-note">This version could not be read.</p>
        )}
      </article>
    </div>
  );
}

/** The content handed over, or read from the host when it was not. */
function useFetched(shown: PrintTarget): string | null {
  const known = shown.content;
  const fetched = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => target?.content ?? null,
  );
  useEffect(() => {
    if (known !== null) return;
    let cancelled = false;
    void api
      .artifact(shown.node.id)
      .then((result) => {
        if (!cancelled && target?.node.id === shown.node.id) set({ node: shown.node, content: result.content });
      })
      .catch(() => {
        if (!cancelled && target?.node.id === shown.node.id) set({ node: shown.node, content: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [known, shown.node]);
  return known ?? fetched;
}
