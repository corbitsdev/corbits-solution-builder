import { Check } from "lucide-react";
import {
  Textarea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
/**
 * Stage-4 design feedback — the canonical flow from build-plan section 10.
 *
 * The mockup renders in a sandboxed iframe. Feedback mode makes it
 * click-to-anchor: clicking an element captures its stable id where one exists,
 * and a DOM path plus role and text fingerprint where one does not.
 *
 * The iframe is `srcdoc` with a restrictive sandbox — a generated design is
 * untrusted content, and it gets no script execution and no same-origin access.
 * Anchoring works because the parent reads the frame's document directly, which
 * a `srcdoc` frame permits without granting the frame anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode, type DesignFeedbackEntry } from "../client.js";
import { revisionPrompt, type Anchor, type Direction } from "@solutions-builder/app/design-prompt";
import { Banner, Button, Field, StateLabel, documentName } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { PrintButton } from "../print.jsx";
import { Elapsed } from "./workspace/elapsed.jsx";
import { designOrdinal } from "./workspace/design-history.ts";
import type { FoldedFeedback } from "@solutions-builder/app/project-state";
import { anchorResolves, shortPromptHash, withFallbackIds, type Disposition } from "../design-disposition.js";
import { Markdown } from "../markdown.jsx";

/**
 * The kit asks the Experience designer for a single self-contained HTML
 * document and nothing else. A local model does not always keep to that —
 * it sometimes answers in markdown instead, restating the chosen approach
 * rather than sketching it. An HTML document goes in the sandboxed preview
 * frame; anything else is rendered as the markdown it actually is, so the
 * reader sees formatted text instead of a raw `##`-and-tags page.
 */
export function looksLikeHtmlDocument(content: string): boolean {
  return /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(content);
}

type PendingComment = { anchor: Anchor; body: string };

/** Builds an anchor for a clicked element, preferring a stable id. */
function anchorFor(element: Element): Anchor {
  const testId =
    element.getAttribute("data-testid") ??
    element.getAttribute("data-test-id") ??
    element.getAttribute("id") ??
    undefined;

  // The DOM path is the fallback, kept short enough to stay readable and
  // indexed so siblings are distinguishable.
  const segments: string[] = [];
  let node: Element | null = element;
  while (node && node.tagName !== "BODY" && segments.length < 5) {
    const parent: Element | null = node.parentElement;
    const index = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
    segments.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }

  const text = (element.textContent ?? "").trim().slice(0, 60);
  return {
    ...(testId ? { testId } : {}),
    domPath: segments.join(" > "),
    ...(element.getAttribute("role") ? { role: element.getAttribute("role")! } : {}),
    ...(text ? { textFingerprint: text } : {}),
  };
}

export function anchorLabel(anchor: Anchor): string {
  if (anchor.testId) return `#${anchor.testId}`;
  return anchor.domPath ?? "(whole design)";
}

/**
 * How the design on screen moves on. `canApprove` is false while the stage is
 * not open for it — waiting on a decision already, or routed back — and the
 * row is not drawn then.
 */
export type DesignApproval = {
  soloApproval: boolean;
  canApprove: boolean;
  onApprove: (design: ArtifactNode) => Promise<unknown>;
};

/**
 * One anchored comment as the submitted-state table renders it, with its
 * disposition (CL-8699). `addressable` is false for a row carried over from
 * before ids existed — `id` is then a positional fallback for rendering
 * only, and the disposition control is disabled since there is no real id to
 * write against.
 */
type SubmittedComment = {
  anchor: Anchor;
  body: string;
  id: string;
  addressable: boolean;
  disposition: Disposition;
  dispositionAt?: string;
};

/** `FoldedFeedback` widened with per-comment disposition — this view's own read of `sb.feedback`, not the (deleted) run fold. */
type SubmittedFeedback = Omit<FoldedFeedback, "comments"> & { comments: readonly SubmittedComment[] };

/** Wraps the recorded notes for one node into the shape the submitted-state panel already renders. */
function foldNodeFeedback(nodeId: string, entries: readonly DesignFeedbackEntry[]): SubmittedFeedback | undefined {
  const last = entries.at(-1);
  if (!last) return undefined;
  return {
    runId: "",
    designNodeId: nodeId,
    direction: "revise",
    overallNote: last.text,
    comments: withFallbackIds(entries, nodeId).map((entry) => ({
      anchor: entry.anchor ?? {},
      body: entry.text,
      id: entry.id,
      addressable: entry.addressable,
      disposition: entry.disposition ?? "open",
      ...(entry.dispositionAt ? { dispositionAt: entry.dispositionAt } : {}),
    })),
    prompt: entries.map((entry) => entry.text).join("\n\n"),
    at: last.at,
  };
}

export function DesignFeedbackView({
  designs,
  contentByNode,
  tenantId,
  approval,
  onChanged,
  revise,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  feedbackByNode: _unusedFeedbackByNode,
}: {
  designs: ArtifactNode[];
  /**
   * Accepted for compatibility with the caller, which still folds an (always
   * empty) map from the deleted lifecycle run — unused: this view now folds
   * feedback itself from each node's own artifact metadata (`sb.feedback`,
   * CL-8620), since that fold no longer has a run to read from.
   */
  feedbackByNode?: Map<string, FoldedFeedback>;
  contentByNode: Map<string, string>;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  approval: DesignApproval;
  onChanged: () => void;
  /**
   * Delivers the feedback and its deterministic revision prompt to the run
   * together, as one `stage.draft` signal — submitting is revising.
   */
  revise: (
    feedback: { designNodeId: string; direction: Direction; overallNote: string; comments: PendingComment[] },
    prompt: string,
  ) => Promise<unknown>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(designs.at(-1)?.id ?? null);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [draftAnchor, setDraftAnchor] = useState<Anchor | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [direction, setDirection] = useState<Direction>("revise");
  const [overallNote, setOverallNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const design = designs.find((entry) => entry.id === selectedId) ?? designs.at(-1) ?? null;
  const content = design ? (contentByNode.get(design.id) ?? "") : "";

  // Feedback on each node lives on that node's own artifact metadata
  // (`sb.feedback`), not the deleted lifecycle run — read straight off it
  // rather than the caller's (always empty) prop, CL-8620.
  const [feedbackByNode, setFeedbackByNode] = useState(new Map<string, SubmittedFeedback>());
  const loadFeedback = useCallback(async () => {
    const persistedIds = designs.map((entry) => entry.id).filter((id) => !id.startsWith("reply:"));
    const entries = await Promise.all(
      persistedIds.map((id) =>
        api
          .designFeedback(tenantId, id)
          .then((notes) => [id, notes] as const)
          .catch(() => [id, []] as const),
      ),
    );
    setFeedbackByNode(
      new Map(
        entries.flatMap(([id, notes]) => {
          const folded = foldNodeFeedback(id, notes);
          return folded ? [[id, folded] as const] : [];
        }),
      ),
    );
  }, [designs, tenantId]);
  useEffect(() => {
    void loadFeedback();
  }, [loadFeedback]);

  const submitted = design ? feedbackByNode.get(design.id) : undefined;

  useEffect(() => {
    setPending([]);
    setDraftAnchor(null);
    setDraftBody("");
  }, [design?.id]);

  // Click-to-anchor. The listener lives on the frame's document, added only
  // while feedback mode is on so ordinary preview stays ordinary.
  useEffect(() => {
    const element = frame.current;
    if (!element || !feedbackMode) return;

    const attach = () => {
      const document_ = element.contentDocument;
      if (!document_) return;
      const onClick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = event.target;
        if (target instanceof Element) setDraftAnchor(anchorFor(target));
      };
      document_.addEventListener("click", onClick, true);
      const style = document_.createElement("style");
      // The frame is sandboxed and inherits none of our theme, so the accent
      // is read from the host and injected as a literal value.
      const accent =
        getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() ||
        "orange"; // not-our-surface: last resort inside a sandboxed frame
      style.textContent = `*{cursor:crosshair!important}*:hover{outline:2px solid ${accent}!important;outline-offset:1px}`;
      document_.head?.append(style);
      return () => {
        document_.removeEventListener("click", onClick, true);
        style.remove();
      };
    };

    let detach = attach();
    const onLoad = () => {
      detach?.();
      detach = attach();
    };
    element.addEventListener("load", onLoad);
    return () => {
      detach?.();
      element.removeEventListener("load", onLoad);
    };
  }, [feedbackMode, design?.id]);

  if (designs.length === 0) {
    return (
      <div className="stage-inner">
        <div className="doc">
          <p className="inline-note">Draft this stage and the first mockup appears here.</p>
        </div>
      </div>
    );
  }

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      await loadFeedback();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stage-inner">
      <div className="doc" data-tour="design-feedback">
        <div className="docmeta">
          <span>
            v{design ? designOrdinal(designs, design) : ""} · {documentName(design?.kind ?? "design_artifact")}
          </span>
          <div className="document-tools">
            {designs.length > 1 ? (
              <select
                aria-label="Version"
                value={design?.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {designs.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    Version {designOrdinal(designs, entry)}
                  </option>
                ))}
              </select>
            ) : null}
            <select
              aria-label="Mode"
              value={feedbackMode ? "feedback" : "preview"}
              onChange={(event) => setFeedbackMode(event.target.value === "feedback")}
            >
              <option value="preview">Preview</option>
              <option value="feedback">Feedback</option>
            </select>
            {design ? <PrintButton node={design} tenantId={tenantId} content={content || null} /> : null}
            {design && approval.canApprove ? (
              <Button
                variant="primary"
                loading={busy === "approve"}
                disabled={busy !== null && busy !== "approve"}
                onClick={() => run("approve", () => approval.onApprove(design))}
              >
                <Check aria-hidden="true" />
                {approval.soloApproval ? "Approve and continue" : "Send for approval"}
              </Button>
            ) : null}
          </div>
        </div>

        {error ? (
          <Banner tone="error" title="That did not go through">
            {error}
          </Banner>
        ) : null}

        {/* The generated design is untrusted: no scripts, no same-origin.

            One frame per document, and none until the document is here. The
            version list arrives before the versions' bodies do, and a frame
            mounted empty and given its document a moment later is a frame
            Chrome loads but never paints: a sandboxed srcdoc frame whose
            document is replaced while its first is still committing stays
            blank for good, with nothing logged. So the frame waits for its
            content and is keyed by the version, which makes a change of
            version a new frame rather than a second navigation. */}
        {!content ? (
          <div className="design-preview" aria-busy="true" aria-label="Loading the design preview" />
        ) : looksLikeHtmlDocument(content) ? (
          <iframe
            key={design?.id}
            ref={frame}
            className="design-preview"
            title={`Design preview: ${design?.title ?? ""} v${design ? designOrdinal(designs, design) : ""}`}
            srcDoc={content}
            sandbox=""
          />
        ) : (
          <div className="design-preview design-preview-markdown">
            <Markdown source={content} />
          </div>
        )}
      </div>

      {feedbackMode && !submitted ? (
        <div className="doc">
          {draftAnchor ? (
            <>
              <dl className="version-list">
                <div>
                  <dt>Anchor</dt>
                  <dd>
                    <span className="hash">{anchorLabel(draftAnchor)}</span>
                    {draftAnchor.testId ? null : (
                      <StateLabel tone="warning">No stable id, so this anchor may go stale</StateLabel>
                    )}
                  </dd>
                </div>
              </dl>
              <Field label="Comment">
                <Dictated value={draftBody} onValueChange={setDraftBody} align="start">
                  <Textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
                </Dictated>
              </Field>
              <div className="button-row">
                <Button
                  disabled={draftBody.trim().length === 0}
                  onClick={() => {
                    setPending([...pending, { anchor: draftAnchor, body: draftBody.trim() }]);
                    setDraftAnchor(null);
                    setDraftBody("");
                  }}
                >
                  Add this comment
                </Button>
                <Button onClick={() => setDraftAnchor(null)}>Cancel</Button>
              </div>
            </>
          ) : (
            <p className="inline-note">Click an element in the preview to anchor a comment.</p>
          )}

          {pending.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Anchor</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((comment, index) => (
                  <TableRow key={`${anchorLabel(comment.anchor)}-${index}`}>
                    <TableCell className="hash">{anchorLabel(comment.anchor)}</TableCell>
                    <TableCell>{comment.body}</TableCell>
                    <TableCell>
                      <Button
                        onClick={() => setPending(pending.filter((_, at) => at !== index))}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}

          <Field
            label="Overall direction"
          >
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value as typeof direction)}
            >
              <option value="revise">Revise this design</option>
              <option value="choose">Choose this design as it stands</option>
              <option value="combine">Combine with another version</option>
              <option value="reject">Reject this direction</option>
            </select>
          </Field>

          <Field label="Note to the designer">
            <Dictated value={overallNote} onValueChange={setOverallNote} align="start">
              <Textarea value={overallNote} onChange={(event) => setOverallNote(event.target.value)} />
            </Dictated>
          </Field>

          <Button
            variant="primary"
            data-tour="design-submit"
            loading={busy === "submit"}
            disabled={!design}
            onClick={() =>
              run("submit", () => {
                const comments = pending.map((comment, index) => ({
                  id: String(index),
                  anchor: comment.anchor,
                  body: comment.body,
                  author: "",
                  disposition: "open" as const,
                }));
                const prompt = revisionPrompt({
                  designTitle: design!.title,
                  designVersion: design!.version,
                  designContentHash: design!.contentHash,
                  direction,
                  overallNote,
                  comments,
                  acceptanceCriteria: [],
                });
                // Recorded on the node's own artifact metadata and mailed to
                // the specialist directly (CL-8620) — independent of, and in
                // addition to, `revise` below, which still carries the
                // deterministic prompt into the next-version request. One
                // entry per anchored comment so its disposition can be set
                // later against that specific comment (CL-8699), plus one
                // un-anchored entry for the overall note when there is one;
                // with neither, the prompt itself stands in. The mail always
                // carries the prompt too, so the designer still sees which
                // element every comment refers to.
                const overallNoteTrimmed = overallNote.trim();
                const anchoredComments = pending.map((comment) => ({ anchor: comment.anchor, text: comment.body }));
                const persistedComments = [
                  ...anchoredComments,
                  ...(overallNoteTrimmed
                    ? [{ text: overallNoteTrimmed }]
                    : anchoredComments.length === 0
                      ? [{ text: prompt }]
                      : []),
                ];
                const mailBody =
                  anchoredComments.length > 0
                    ? overallNoteTrimmed
                      ? `${overallNoteTrimmed}\n\n${prompt}`
                      : prompt
                    : overallNoteTrimmed || prompt;
                const attach = design!.id.startsWith("reply:")
                  ? Promise.resolve()
                  : api
                      .submitDesignFeedback(tenantId, { id: design!.id, title: design!.title }, {
                        mailBody,
                        comments: persistedComments,
                      })
                      .catch(() => {
                        // Feedback on a not-yet-persisted design is best
                        // effort: the mail and prompt below still go out.
                      });
                return Promise.all([
                  attach,
                  revise({ designNodeId: design!.id, direction, overallNote, comments: pending }, prompt),
                ]);
              })
            }
          >
            Submit feedback and generate the next version
          </Button>
          {busy === "submit" ? <Elapsed /> : null}
        </div>
      ) : null}

      {submitted ? (
        <div className="doc">
          <div className="docmeta">
            <span>
              {submitted.direction}
              {submitted.overallNote ? ` · ${submitted.overallNote}` : ""}
            </span>
            <span className="hash">prompt {shortPromptHash(submitted.prompt)}</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Anchor</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>Disposition</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submitted.comments.map((comment, index) => (
                <TableRow key={`${comment.id}-${index}`}>
                  <TableCell className="hash">{anchorLabel(comment.anchor)}</TableCell>
                  <TableCell>{comment.body}</TableCell>
                  <TableCell>
                    <div className="feedback-disposition">
                      <select
                        value={comment.disposition}
                        disabled={busy !== null || !comment.addressable}
                        title={comment.addressable ? undefined : "Recorded before dispositions existed"}
                        onChange={(event) =>
                          run(`disposition-${comment.id}`, () =>
                            api.setDesignFeedbackDisposition(
                              tenantId,
                              { id: design!.id },
                              comment.id,
                              event.target.value as Disposition,
                            ),
                          )
                        }
                      >
                        <option value="open">Open</option>
                        <option value="addressed">Addressed</option>
                        <option value="declined">Declined</option>
                      </select>
                      {!anchorResolves(comment.anchor, content) ? (
                        <StateLabel tone="warning">anchor no longer resolves</StateLabel>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="artifact">
            <pre>{submitted.prompt}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
