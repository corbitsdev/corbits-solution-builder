import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ArtifactNode,
  type Evaluation,
  type Quote,
  type StageTurn,
} from "../../client.js";
import {
  ChatInput,
  ChatThread,
  Switch,
  type ChatMessage,
} from "@corbits/react-ui";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { Markdown } from "../../markdown.jsx";
import { Dictated } from "../../dictation.jsx";
import { approachName, sectionsIn } from "@solutions-builder/app/document";
import { agentFor } from "@solutions-builder/app/kit";
import type { Stage } from "@solutions-builder/app/ledger";
import { markChanges } from "../../revisions.js";
import { AddMaterial, Button, documentName } from "../../components.jsx";
import { PrintButton } from "../../print.jsx";
import { SpecialistTurn, WorkingLabel, type TurnNote } from "./thread.jsx";

/**
 * A drafted stage: the document, and the conversation about it.
 *
 * Exported so `scripts/walk-ui.tsx` renders this rather than a copy. The copy
 * drifted within a day — it was still showing a header and a button row that
 * had been redesigned — which is the whole reason the harness is not allowed
 * to describe surfaces itself.
 *
 * One composer, because there is one thing a person does here — say what
 * should change — and it does not become two things because they happened to
 * select some text first. Selecting a passage attaches it to the message being
 * written, and several can be attached before sending. Typing without
 * selecting anything is the ordinary case and stays ordinary.
 */
export function StageDocument({
  node,
  versions,
  content,
  tenantId,
  turns,
  openQuestion,
  evaluation = null,
  onSelectVersion,
  onRevise,
  onAddMaterial,
  onSubmit,
  soloApproval,
  canSubmit,
  busy,
  draftOpen = true,
  newer = null,
  live = null,
}: {
  node: ArtifactNode;
  versions: ArtifactNode[];
  content: string;
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  turns: StageTurn[];
  /** A question visibly recorded in the latest specialist mail. */
  openQuestion: { text: string } | null;
  /** The stage-1 brief evaluator's verdict, advisory only. Null off stage 1. */
  evaluation?: Evaluation | null;
  onSelectVersion: (id: string) => void;
  onRevise: (message: string, quotes: Quote[], revise?: boolean) => void;
  /** Hands files over as material, mid-project. Absent where nothing can be added. */
  onAddMaterial?: ((files: File[]) => Promise<void>) | undefined;
  onSubmit: () => void;
  soloApproval: boolean;
  canSubmit: boolean;
  busy: string | null;
  /** The draft pane beside the conversation; the header's toggle. */
  draftOpen?: boolean;
  /** A version newer than the one being read, when there is one. */
  newer?: ArtifactNode | null;
  /** The next version, as far as the model has written it. */
  live?: string | null;
}) {
  const [message, setMessage] = useState("");
  const [attached, setAttached] = useState<Quote[]>([]);
  // Stage 3 is a choice, not an approval: the gate names the approaches.
  const sections = useMemo(() => sectionsIn(content), [content]);
  const approaches = node.kind === "chosen_approach"
    ? sections.filter((section) => approachName(section.heading) !== null)
    : [];
  const chosen = sections.some((section) => /^chosen approach\b/i.test(section.heading));
  const choosing = approaches.length > 0 && !chosen;
  const [redrafting, setRedrafting] = useState(false);
  // Against the version before this one, like tracked changes: what a revision
  // did is otherwise something the reader has to find by rereading the whole
  // document.
  const previous = versions.find((entry) => entry.version === node.version - 1) ?? null;
  const [showChanges, setShowChanges] = useState(true);
  const [previousContent, setPreviousContent] = useState<string | null>(null);
  useEffect(() => {
    setPreviousContent(null);
    if (!previous) return;
    let cancelled = false;
    void api
      .artifactContent(tenantId, previous.id)
      .then((result) => {
        if (!cancelled) setPreviousContent(result.content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [previous?.id, tenantId]);
  // Closed by default. While the specialist is still asking, the document is
  // the thing being written rather than the thing being read, and a wall of
  // draft beside a question is what made this feel like homework.
  const composer = useRef<HTMLTextAreaElement>(null);
  // ChatThread owns the transcript's scrolling, including staying put while
  // the reader is scrolled up.

  /** A selection in the document attaches to the message being written. */
  const attachSelection = () => {
    const selection = globalThis.getSelection?.();
    const text = selection?.toString().trim() ?? "";
    if (text.length === 0) return;
    const quote = text.length > 240 ? `${text.slice(0, 240)}…` : text;
    if (attached.some((entry) => entry.quote === quote)) return;
    setAttached([...attached, { quote }]);
    selection?.removeAllRanges();
    composer.current?.focus({ preventScroll: true });
  };

  // Our turns as the library's message model. A quote the person attached is
  // part of what they said, so it travels in the same message rather than
  // becoming a second kind of thing.
  // Memoised: the thread re-pins its scroll whenever this array is new, and a
  // fresh one on every keystroke in the composer made the transcript twitch.
  // The turns that report a round the platform could not complete, set apart in the transcript.
  const failedTurns = useMemo(() => new Set(turns.filter((turn) => turn.failed).map((turn) => turn.id)), [turns]);

  const messages: ChatMessage[] = useMemo(() => {
    const list: ChatMessage[] = turns.map((turn) => ({
      id: turn.id,
      role: turn.role === "specialist" ? "agent" : "user",
      createdAt: turn.createdAt,
      parts: [
        ...turn.quotes.map((entry) => ({ type: "text" as const, text: `> ${entry.quote}` })),
        { type: "text" as const, text: turn.body },
      ],
    }));
    // A turn in flight has no row of its own yet, so the transcript would sit
    // unchanged after the person hits send. This is the one message the thread
    // shows that the host has not recorded.
    if (busy === "draft") {
      // Its time is hidden in CSS: "6s ago" under a turn that has not happened
      // is noise, and the bubble always stamps one.
      list.push({
        id: "pending",
        role: "agent",
        createdAt: new Date().toISOString(),
        parts: [{ type: "text", text: "Writing…" }],
      });
    }
    return list;
  }, [turns, busy]);

  // What each specialist turn did with the answer before it: which version the
  // answer produced, and whether the question that follows continues the same
  // interview or opens a new one after a full re-read. The turn itself only
  // says the question, so without this an answer looks unheard.
  const versionOf = new Map(versions.map((entry) => [entry.id, entry.version]));
  const noun = documentName(node.kind).toLowerCase();
  const notes = new Map<string, TurnNote>();
  turns.forEach((turn, index) => {
    if (turn.role !== "specialist") return;
    const answered = turns[index - 1]?.role === "human";
    const version = turn.resultNodeId ? (versionOf.get(turn.resultNodeId) ?? null) : null;
    if (!answered && version === null) return;
    notes.set(turn.id, {
      answered,
      version,
      nodeId: turn.resultNodeId,
      fresh: turn.body.startsWith("The draft is beside this"),
      noun,
    });
  });

  // The composer grows as a person types. The transcript above it shrinks by
  // the same amount, and unless it is re-pinned in the same frame the last
  // line slides under the box and back out again on every wrap.
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const section = pane.current;
    const box = section?.querySelector<HTMLElement>(".composer");
    const log = section?.querySelector<HTMLElement>('[role="log"]');
    if (!box || !log) return;
    let pinned = true;
    const onScroll = () => {
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    };
    log.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(() => {
      if (pinned) log.scrollTop = log.scrollHeight;
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      log.removeEventListener("scroll", onScroll);
    };
  }, [messages.length === 0]);

  // The transcript is ChatThread's scroll box, and it only follows the bottom
  // when the reader is already there. Sending is the one moment they want to
  // be taken down anyway, and reading back up needs a way back.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const transcript = () => pane.current?.querySelector<HTMLElement>(".thread-turns") ?? null;
  const scrollToBottom = () => {
    const box = transcript();
    box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  };
  useEffect(() => {
    const box = transcript();
    if (!box) return;
    const measure = () =>
      setAwayFromBottom(box.scrollHeight - box.scrollTop - box.clientHeight > 96);
    measure();
    box.addEventListener("scroll", measure, { passive: true });
    const sized = new ResizeObserver(measure);
    sized.observe(box);
    return () => {
      box.removeEventListener("scroll", measure);
      sized.disconnect();
    };
  }, [turns.length, busy]);

  // Sent while the specialist is still writing, a message waits here and
  // goes the moment the draft lands. Typing is never blocked: a person who
  // has more to say should not have to hold it in their head until a spinner
  // stops. Only one run at a time, though, so the send itself waits.
  const [queued, setQueued] = useState(false);
  const send = () => {
    if (message.trim().length === 0 && attached.length === 0) return;
    if (busy !== null) {
      setQueued(true);
      return;
    }
    setQueued(false);
    onRevise(message.trim(), attached);
    setMessage("");
    setAttached([]);
    setRedrafting(false);
    // After the pending turn has rendered, so the scroll reaches it.
    requestAnimationFrame(scrollToBottom);
  };

  useEffect(() => {
    if (busy === null && queued) send();
    // `send` reads the current message and attachments; it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queued]);

  return (
    <div className={draftOpen ? "document-layout" : "document-layout is-solo"}>
      <section ref={pane} className="stage-thread" aria-label="Conversation with the specialist">
        <header className="thread-head">
          {/* With the draft open its own header names the stage, so this says
              only what that does not. */}
          {/* The draft's own header carries the stage, so this says only what
              that does not. */}
          <span className="thread-progress">
            {openQuestion ? "Question awaiting your answer" : ""}
          </span>
        </header>

        <div className="thread-scroll">
        <ChatThread
          className="thread-turns"
          messages={messages}
          identity={{ name: "Specialist", initials: "SB" }}
          // A specialist's turn is its digest of the draft, and the bolding in
          // it is the point — it is what a reader takes in first.
          renderBody={(message) =>
            message.id === "pending" ? (
              <WorkingLabel />
            ) : message.role === "agent" && failedTurns.has(message.id) ? (
              <div className="turn-failed" role="alert">
                <Markdown source={(message.parts[0] as { text: string }).text} />
              </div>
            ) : message.role === "agent" ? (
              <SpecialistTurn
                text={(message.parts[0] as { text: string }).text}
                note={notes.get(message.id) ?? null}
                onOpenVersion={onSelectVersion}
                // Tapping a choice sends it, exactly as typing it would. That
                // holds outside the interview too: a brainstormer proposing
                // options is asking for a choice, whether or not a question
                // is queued.
                onAnswer={
                  busy === null && message.id === messages.at(-1)?.id
                    ? (answer) => onRevise(answer, [])
                    : undefined
                }
              />
            ) : undefined
          }
          empty={
            <div className="thread-empty">
              {/* The document is beside this, so what is missing is the
                  conversation, not the specialist: say which document, and
                  who wrote it. */}
              <p>No conversation about this {noun} is recorded yet.</p>
              <p>
                The {agentFor(node.stage as Stage).title.toLowerCase()} wrote it. Say what should change, or approve it as
                it is.
              </p>
            </div>
          }
        />
        <button
          type="button"
          className="jump-down"
          hidden={!awayFromBottom}
          onClick={scrollToBottom}
          aria-label="Jump to the latest message"
        >
          <ArrowDown aria-hidden="true" />
        </button>
        </div>

        <div className="composer" data-tour="composer" data-working={busy === "draft" || undefined}>
          {/* The specialist has gone quiet without asking anything. Whose move
              it is has to be said, or the screen reads as stuck. */}
          {canSubmit && !openQuestion && busy === null && turns.at(-1)?.role === "specialist" && !turns.at(-1)!.body.trimEnd().endsWith("?") ? (
            <p className="composer-cue">
              Nothing more to ask. Approve it, or say what should change and it will redraft.
            </p>
          ) : null}
          {canSubmit && choosing ? (
            <div className="composer-approve composer-choose">
              <span>Which approach?</span>
              {approaches.map((section) => {
                const letter = /^approach\s+([ab])/i.exec(section.heading)?.[1]?.toUpperCase() ?? "A";
                const name = approachName(section.heading) ?? `Approach ${letter}`;
                return (
                  <Button
                    key={section.heading}
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() =>
                      onRevise(
                        `Chosen: Approach ${letter} (${name}). Rewrite the document so the top says which approach was chosen and why, keep the other as the rejected alternative, keep Side by side.`,
                        [],
                        true,
                      )
                    }
                  >
                    {name}
                  </Button>
                );
              })}
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setRedrafting(true);
                  composer.current?.focus();
                }}
              >
                Neither, redraft
              </Button>
            </div>
          ) : canSubmit ? (
            <div className="composer-approve">
              <span>{soloApproval ? "Happy with it?" : "Nothing more to say?"}</span>
              <span
                data-tour="submit"
                data-ready={evaluation?.ready ? "true" : undefined}
                className={evaluation?.ready ? "is-ready" : undefined}
              >
                <Button variant="ghost" loading={busy === "submit"} onClick={onSubmit}>
                  <Check aria-hidden="true" />
                  {soloApproval ? "Approve and continue" : "Send for approval"}
                </Button>
              </span>
            </div>
          ) : null}
          <Dictated value={message} onValueChange={setMessage}>
          <ChatInput
            value={message}
            onValueChange={setMessage}
            onSend={send}
            working={busy === "draft"}
            placeholder={
              busy === "draft"
                ? "The specialist is writing. Say more meanwhile; it goes when the draft lands."
                : redrafting && choosing
                  ? "What should be different about the approaches?"
                  : attached.length > 0
                  ? "What should change about this?"
                  : openQuestion
                    ? "Your answer. Rough is fine."
                    : "What should change? Add as much as you like."
            }
            attachments={attached.map((entry, index) => ({
              id: `${index}`,
              name: entry.quote,
            }))}
            onRemoveAttachment={(entry) =>
              setAttached(attached.filter((_, at) => `${at}` !== entry.id))
            }
            textareaRef={composer}
          />
          </Dictated>
          {queued && busy !== null ? (
            <p className="composer-cue" aria-live="polite">
              Held until the specialist finishes, then sent.
            </p>
          ) : null}
          {onAddMaterial ? (
            <p className="composer-cue">
              <AddMaterial className="material-add-inline" onAdd={onAddMaterial} />{" "}
              or drop files anywhere here. The specialists read them with their next draft.
            </p>
          ) : null}
        </div>
      </section>

      <article className="document" data-tour="document">
        <header className="document-header">
          <h2>{documentName(node.kind)}</h2>
          {live !== null ? (
            <span className="thinking">Writing version {node.version + 1}</span>
          ) : newer ? (
            <button type="button" className="newer-version" onClick={() => onSelectVersion(newer.id)}>
              <ArrowUp aria-hidden="true" />
              Version {newer.version} is ready
            </button>
          ) : null}
          {/* Stacked, picker over toggle: on one line they fought the title for
              width and the title wrapped. */}
          <div className="document-tools">
            {versions.length > 1 ? (
              <select
                aria-label="Version"
                value={node.id}
                onChange={(event) => onSelectVersion(event.target.value)}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    Version {version.version}
                    {version.supersededByNodeId ? " (superseded)" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            {previous ? (
              <label className="changes-toggle" htmlFor="show-changes">
                <Switch id="show-changes" checked={showChanges} onCheckedChange={setShowChanges} />
                <span>Changes since v{previous.version}</span>
              </label>
            ) : null}
            <PrintButton node={node} tenantId={tenantId} content={content || null} />
          </div>
        </header>
        <div className="document-body" data-tour="document-body" onMouseUp={attachSelection}>
          {live !== null ? (
            <div className="is-live">
              <Markdown source={live} />
            </div>
          ) : content ? (
            <DocumentBody
              source={
                showChanges && previousContent !== null ? markChanges(previousContent, content) : content
              }
              sideBySide={approaches.length >= 2}
            />
          ) : (
            <p className="inline-note">Loading…</p>
          )}
        </div>
      </article>
    </div>
  );
}

/**
 * The document, with stage 3's two approaches laid side by side so the
 * comparison is one glance rather than a scroll. The same markdown, grouped by
 * heading; anything that is not an approach renders in order as before.
 */
export function DocumentBody({ source, sideBySide }: { source: string; sideBySide: boolean }) {
  if (!sideBySide) return <Markdown source={source} />;
  const sections = sectionsIn(source);
  const first = sections.findIndex((section) => approachName(section.heading) !== null);
  const isApproach = (section: { heading: string }) => approachName(section.heading) !== null;
  const text = (section: { heading: string; body: string }) =>
    section.heading ? `## ${section.heading}\n${section.body}` : section.body;
  return (
    <>
      {sections.slice(0, first).map((section, index) => (
        <Markdown key={`pre-${index}`} source={text(section)} />
      ))}
      <div className="approaches">
        {sections.filter(isApproach).map((section) => (
          <section key={section.heading} className="approach">
            <Markdown source={text(section)} />
          </section>
        ))}
      </div>
      {sections
        .slice(first)
        .filter((section) => !isApproach(section))
        .map((section, index) => (
          <Markdown key={`post-${index}`} source={text(section)} />
        ))}
    </>
  );
}
