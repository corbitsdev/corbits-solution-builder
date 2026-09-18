import { Check } from "lucide-react";
import {
  Textarea,
  EmptyState,
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
import { useEffect, useRef, useState } from "react";
import { ApiFailure, type ArtifactNode } from "../client.js";
import { revisionPrompt, type Anchor, type Direction } from "@solutions-builder/app/design-prompt";
import { Banner, Button, Field, Screen, StateLabel } from "../components.jsx";
import { Dictated } from "../dictation.jsx";
import { PrintButton } from "../print.jsx";
import { Elapsed } from "./workspace/elapsed.jsx";
import type { FoldedFeedback } from "../run-fold.ts";

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

export function DesignFeedbackView({
  designs,
  feedbackByNode,
  contentByNode,
  tenantId,
  approval,
  onChanged,
  revise,
}: {
  designs: ArtifactNode[];
  /** The feedback recorded against each design version, folded from the run's own events. */
  feedbackByNode: Map<string, FoldedFeedback>;
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
      <Screen
        title="No design version yet"
      >
        <EmptyState
          title="No design yet"
          description="Draft this stage and the first mockup appears here."
        />
      </Screen>
    );
  }

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {/* The way forward, first and in plain sight. A screen that offers
          feedback and a next version but no approval reads as a screen you
          cannot leave — the guide was telling people to approve, and nothing
          on the page let them. */}
      {design && approval.canApprove ? (
        <div className="stage-gate" role="status">
          <span className="stage-gate-dot" aria-hidden="true" />
          <p>
            {approval.soloApproval
              ? `Happy with version ${design.version}? Approving it starts the next stage. To change it first, switch Mode to Feedback and say what should change.`
              : `Version ${design.version} goes to the people who decide when you send it. To change it first, switch Mode to Feedback.`}
          </p>
          <Button
            variant="primary"
            loading={busy === "approve"}
            disabled={busy !== null && busy !== "approve"}
            onClick={() => run("approve", () => approval.onApprove(design))}
          >
            <Check aria-hidden="true" />
            {approval.soloApproval ? "Approve and continue" : "Send for approval"}
          </Button>
        </div>
      ) : null}
      <div data-tour="design-feedback">
      <Screen
        title="Design feedback"
        description="Click an element to anchor a comment."
        status={
          submitted ? (
            <StateLabel tone="success">Feedback submitted</StateLabel>
          ) : feedbackMode ? (
            <StateLabel tone="selected">Feedback mode: click an element</StateLabel>
          ) : (
            <StateLabel tone="info">Preview</StateLabel>
          )
        }
      >
        {error ? <Banner tone="error" title="That did not go through">{error}</Banner> : null}

        <div className="bento">
          <div className="span-6">
            <Field label="Design version">
              <select
                value={design?.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {designs.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    v{entry.version} — {new Date(entry.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="span-6">
            <Field label="Mode" >
              <select
                value={feedbackMode ? "feedback" : "preview"}
                onChange={(event) => setFeedbackMode(event.target.value === "feedback")}
              >
                <option value="preview">Preview</option>
                <option value="feedback">Feedback</option>
              </select>
            </Field>
          </div>
        </div>

        {design ? (
          <p className="inline-note design-reviewing">
            <span>
              Reviewing {design.title}, version {design.version}.
            </span>
            <PrintButton node={design} tenantId={tenantId} content={content || null} />
          </p>
        ) : null}

        {/* The generated design is untrusted: no scripts, no same-origin. */}
        <iframe
          ref={frame}
          title={`Design preview: ${design?.title ?? ""} v${design?.version ?? ""}`}
          srcDoc={content}
          sandbox=""
          style={{
            width: "100%",
            // Most of the window, not a strip of it: the mockup is the thing
            // being reviewed. It scrolls inside the frame past that.
            height: "clamp(460px, 72vh, 1100px)",
            border: "1px solid var(--wb-border)",
            background: "#fff", // not-our-surface: a generated mockup is its
            // own page and renders on white whatever theme the app wears.
          }}
        />
      </Screen>
      </div>

      {feedbackMode && !submitted ? (
        <Screen title="Anchored comments">
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
                return revise({ designNodeId: design!.id, direction, overallNote, comments: pending }, prompt);
              })
            }
          >
            Submit feedback and generate the next version
          </Button>
          {busy === "submit" ? <Elapsed stage={4} /> : null}
          </Screen>
      ) : null}

      {submitted ? (
        <Screen
          title={`Feedback: ${submitted.direction}`}
          description={submitted.overallNote || "No overall note was recorded."}
          status={<StateLabel tone="success">Feedback submitted</StateLabel>}
          tight
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Anchor</TableHead>
                <TableHead>Comment</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submitted.comments.map((comment, index) => (
                <TableRow key={`${anchorLabel(comment.anchor)}-${index}`}>
                  <TableCell className="hash">{anchorLabel(comment.anchor)}</TableCell>
                  <TableCell>{comment.body}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="screen-body">
            <div className="artifact">
              <pre>{submitted.prompt}</pre>
            </div>
          </div>
        </Screen>
      ) : null}
    </>
  );
}
