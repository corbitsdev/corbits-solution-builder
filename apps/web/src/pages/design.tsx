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
import {
  api,
  ApiFailure,
  type ArtifactNode,
  type DesignAnchor,
  type DesignFeedback,
} from "../client.js";
import { Banner, Button, Field, Screen, StateLabel, shortHash } from "../components.jsx";
import { PrintButton } from "../print.jsx";

type PendingComment = { anchor: DesignAnchor; body: string };

/** Builds an anchor for a clicked element, preferring a stable id. */
function anchorFor(element: Element): DesignAnchor {
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

export function anchorLabel(anchor: DesignAnchor): string {
  if (anchor.testId) return `#${anchor.testId}`;
  return anchor.domPath ?? "(whole design)";
}

export function DesignFeedbackView({
  projectId,
  designs,
  feedbackByNode,
  contentByNode,
  onChanged,
}: {
  projectId: string;
  designs: ArtifactNode[];
  feedbackByNode: Map<string, { feedback?: DesignFeedback; prompt?: string }>;
  contentByNode: Map<string, string>;
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(designs.at(-1)?.id ?? null);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [draftAnchor, setDraftAnchor] = useState<DesignAnchor | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [direction, setDirection] = useState<"choose" | "combine" | "revise" | "reject">("revise");
  const [overallNote, setOverallNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const design = designs.find((entry) => entry.id === selectedId) ?? designs.at(-1) ?? null;
  const content = design ? (contentByNode.get(design.id) ?? "") : "";
  const stored = design ? feedbackByNode.get(design.id) : undefined;
  const submitted = stored?.feedback;

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
            <PrintButton node={design} content={null} />
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
                <Textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
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
            <Textarea value={overallNote} onChange={(event) => setOverallNote(event.target.value)} />
          </Field>

          <Button
            variant="primary"
            data-tour="design-submit"
            loading={busy === "submit"}
            disabled={!design}
            onClick={() =>
              run("submit", () =>
                api.submitFeedback(projectId, {
                  designNodeId: design!.id,
                  direction,
                  overallNote,
                  comments: pending,
                }),
              )
            }
          >
            Submit feedback
          </Button></Screen>
      ) : null}

      {submitted ? (
        <Screen
          title={`Feedback: ${submitted.direction}`}
          description={submitted.overallNote || "No overall note was recorded."}
          status={<StateLabel tone="selected">prompt {shortHash(submitted.promptHash)}</StateLabel>}
          tight
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Anchor</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>Disposition</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submitted.comments.map((comment) => (
                <TableRow key={comment.id}>
                  <TableCell className="hash">{anchorLabel(comment.anchor)}</TableCell>
                  <TableCell>{comment.body}</TableCell>
                  <TableCell>
                    {comment.disposition === "addressed" ? (
                      <StateLabel tone="success">Addressed</StateLabel>
                    ) : comment.disposition === "declined" ? (
                      <StateLabel tone="warning">Declined</StateLabel>
                    ) : (
                      <StateLabel tone="info">Open</StateLabel>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="screen-body">
            <Button
              variant="primary"
              loading={busy === "revise"}
              onClick={() => run("revise", () => api.reviseDesign(projectId, design!.id))}
            >
              Generate the next design version
            </Button>{stored?.prompt ? (
              <div className="artifact">
                <pre>{stored.prompt}</pre>
              </div>
            ) : null}
          </div>
        </Screen>
      ) : null}
    </>
  );
}
