/**
 * The artifact library.
 *
 * History is retained on the nodes themselves; the surface is the current
 * documents, read. Replaced versions stay in the footer of the one that
 * replaced them.
 */
import { EmptyState } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "../client.js";
import { Markdown } from "../markdown.jsx";
import { AddMaterial, Banner, Button, documentName, stageName } from "../components.jsx";
import { PrintButton } from "../print.jsx";

type ArtifactEdge = { childNodeId: string; sourceNodeId: string };

/** Kind plus variant: stage-5 parallel artifacts must not collapse into one row. */
function documentIdentity(node: ArtifactNode): string {
  return `${node.kind}\0${node.variant ?? ""}`;
}

/**
 * What a row is called. A stage-5 package or a piece of material is named by
 * its variant — the audience, the file. A design's feedback is named for the
 * design it was given on, not by the node id its variant happens to hold.
 */
function documentLabel(node: ArtifactNode, nodes: ArtifactNode[] = []): string {
  // The build is named after the project, as its file is.
  if (node.kind === "build_evidence") return node.title;
  if (node.kind === "design_feedback") {
    const design = nodes.find((candidate) => candidate.id === node.variant);
    return design ? `Feedback on Design v${design.version}` : "Design feedback";
  }
  return node.variant ?? documentName(node.kind);
}

function pickLatest(left: ArtifactNode, right: ArtifactNode): ArtifactNode {
  if (right.stage !== left.stage) return right.stage > left.stage ? right : left;
  if (right.version !== left.version) return right.version > left.version ? right : left;
  return left;
}

/**
 * One row per identity, the live version. Empty future stages never appear
 * because they have no nodes to group.
 */
function currentRows(nodes: ArtifactNode[]): ArtifactNode[] {
  const byIdentity = new Map<string, ArtifactNode[]>();
  for (const node of nodes) {
    const key = documentIdentity(node);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), node]);
  }
  const rows: ArtifactNode[] = [];
  for (const versions of byIdentity.values()) {
    const live = versions.filter((node) => node.supersededByNodeId === null);
    const pool = live.length > 0 ? live : versions;
    rows.push(pool.reduce(pickLatest));
  }
  return rows;
}

/**
 * Newest first: the stage under way at the top, and within a stage the
 * document written most recently first. What the person is working on is
 * what they came to read; the problem brief from week one is at the bottom.
 */
function groupedRows(nodes: ArtifactNode[]): { stage: number; documents: ArtifactNode[] }[] {
  const byStage = new Map<number, ArtifactNode[]>();
  for (const row of currentRows(nodes)) {
    byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row]);
  }
  return [...byStage.keys()]
    .sort((left, right) => right - left)
    .map((stage) => ({
      stage,
      documents: (byStage.get(stage) ?? []).sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
      ),
    }));
}

/** Live versions only; if several, the furthest-along one. Always open something. */
function defaultOpenedId(nodes: ArtifactNode[]): string | null {
  if (nodes.length === 0) return null;
  const live = nodes.filter((node) => node.supersededByNodeId === null);
  return (live.length > 0 ? live : nodes).reduce(pickLatest).id;
}

function replacedByVersion(node: ArtifactNode, nodes: ArtifactNode[]): number | null {
  if (node.supersededByNodeId === null) return null;
  return nodes.find((candidate) => candidate.id === node.supersededByNodeId)?.version ?? null;
}

function incomingSources(
  nodeId: string,
  edges: ArtifactEdge[],
  nodes: ArtifactNode[],
): ArtifactNode[] {
  const found: ArtifactNode[] = [];
  for (const edge of edges) {
    if (edge.childNodeId !== nodeId) continue;
    const source = nodes.find((node) => node.id === edge.sourceNodeId);
    if (source) found.push(source);
  }
  return found;
}

function identityVersions(node: ArtifactNode, nodes: ArtifactNode[]): ArtifactNode[] {
  const key = documentIdentity(node);
  return nodes
    .filter((candidate) => documentIdentity(candidate) === key)
    .sort((left, right) => right.version - left.version);
}

function statusWords(node: ArtifactNode, nodes: ArtifactNode[]): string {
  const replaced = replacedByVersion(node, nodes);
  if (replaced !== null) return `Replaced by version ${replaced}`;
  if (node.supersededByNodeId !== null) return "Replaced";
  return "Current";
}

function draftedBy(node: ArtifactNode): string {
  const role = node.provenance.agentRole;
  return role ? ` · drafted by the ${role.replace(/-/g, " ")}` : "";
}

export function ArtifactGraph({
  nodes,
  edges,
  contents,
  openedId: openedIdProp,
  onAddMaterial,
}: {
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  contents?: Record<string, string> | undefined;
  openedId?: string;
  /** Hands files over as material, mid-project. Absent where nothing can be added. */
  onAddMaterial?: ((files: File[]) => Promise<void>) | undefined;
}) {
  const addControl = onAddMaterial ? (
    <AddMaterial
      className="library-add"
      onAdd={async (files) => {
        try {
          await onAddMaterial(files);
        } catch (cause) {
          throw new Error(cause instanceof ApiFailure ? cause.detail.message : String(cause));
        }
      }}
    />
  ) : null;
  const [openedId, setOpenedId] = useState<string | null>(
    () => openedIdProp ?? defaultOpenedId(nodes),
  );

  useEffect(() => {
    if (openedIdProp) {
      setOpenedId(openedIdProp);
      return;
    }
    if (openedId && nodes.some((node) => node.id === openedId)) return;
    setOpenedId(defaultOpenedId(nodes));
  }, [nodes, openedId, openedIdProp]);

  if (nodes.length === 0) {
    return (
      <div className="library-empty">
        <EmptyState
          title="Nothing produced yet"
          description="Draft the current stage and the first document appears."
        />
        {addControl}
      </div>
    );
  }

  const opened =
    nodes.find((node) => node.id === openedId) ??
    nodes.find((node) => node.id === defaultOpenedId(nodes)) ??
    nodes[0]!;
  const selectedKey = documentIdentity(opened);
  const openNode = (id: string) => setOpenedId(id);

  return (
    <div className="library-layout">
      <aside className="library-list" aria-label="Documents">
        {addControl}
        {groupedRows(nodes).map((group) => (
          <section key={group.stage}>
            <p className="queue-list-head">{stageName(group.stage)}</p>
            {group.documents.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`queue-item${documentIdentity(row) === selectedKey ? " is-selected" : ""}`}
                aria-current={documentIdentity(row) === selectedKey ? "true" : undefined}
                onClick={() => openNode(row.id)}
              >
                <strong>{documentLabel(row, nodes)}</strong>
                <p>{`Version ${row.version}`}</p>
              </button>
            ))}
          </section>
        ))}
      </aside>

      <article className="document">
        <ArtifactReader
          key={opened.id}
          node={opened}
          nodes={nodes}
          edges={edges}
          contents={contents}
          onOpen={openNode}
        />
      </article>
    </div>
  );
}

function ArtifactReader({
  node,
  nodes,
  edges,
  contents,
  onOpen,
}: {
  node: ArtifactNode;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  contents?: Record<string, string> | undefined;
  onOpen: (id: string) => void;
}) {
  const injected = contents?.[node.id];
  const [content, setContent] = useState<string | null>(injected ?? null);

  useEffect(() => {
    if (contents && Object.hasOwn(contents, node.id)) {
      setContent(contents[node.id] ?? "");
      return;
    }
    let cancelled = false;
    setContent(null);
    void api
      .artifact(node.id)
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, contents]);

  const replaced = replacedByVersion(node, nodes);
  const kicker =
    replaced !== null
      ? `Replaced by version ${replaced}`
      : node.supersededByNodeId !== null
        ? "Replaced"
        : `Version ${node.version}${draftedBy(node)}`;
  const sources = incomingSources(node.id, edges, nodes);
  const versions = identityVersions(node, nodes);
  const earlier = versions.filter((version) => version.id !== node.id);
  const hasFoot = sources.length > 0 || earlier.length > 0;

  return (
    <>
      <header className="document-header">
        <div>
          <h2>{documentLabel(node, nodes)}</h2>
          <p>{kicker}</p>
        </div>
        {node.kind === "audience_deck" || node.kind === "build_evidence" ? null : <PrintButton node={node} content={content} />}
      </header>
      <div className="document-body">
        {content === null ? (
          <p className="inline-note">Loading…</p>
        ) : content ? (
          node.kind === "source_material" ? (
            <Material node={node} content={content} />
          ) : node.kind === "audience_deck" ? (
            <DeckFile node={node} />
          ) : node.kind === "build_evidence" ? (
            <BuildFile node={node} />
          ) : node.kind === "design_feedback" ? (
            <FeedbackRecord content={content} />
          ) : node.mediaType === "text/html" || node.kind === "design_artifact" ? (
            // A design is a page. It renders as one, in the same sandbox the
            // design review uses: no scripts, no origin, nothing reaches out.
            <iframe
              className="artifact-page"
              title={`${documentLabel(node, nodes)} v${node.version}`}
              srcDoc={content}
              sandbox=""
              style={{ background: "#fff" }} // not-our-surface: a generated mockup is its own page
            />
          ) : (
            <Markdown source={content} />
          )
        ) : (
          <p className="inline-note">This version could not be read.</p>
        )}
      </div>
      {hasFoot ? (
        <footer className="library-foot">
          {sources.length > 0 ? (
            <p>
              {sources.map((source, index) => (
                <span key={source.id}>
                  {index > 0 ? " · " : null}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpen(source.id)}
                  >
                    {`Built from ${documentLabel(source, nodes)} v${source.version}`}
                  </button>
                </span>
              ))}
            </p>
          ) : null}
          {earlier.length > 0 ? (
            <p>
              Earlier versions{" "}
              <select
                aria-label="Earlier versions"
                value={node.id}
                onChange={(event) => onOpen(event.target.value)}
              >
                {versions.map((version) => {
                  const status = statusWords(version, nodes);
                  return (
                    <option key={version.id} value={version.id}>
                      {`Version ${version.version} · ${status}`}
                    </option>
                  );
                })}
              </select>
            </p>
          ) : null}
        </footer>
      ) : null}
    </>
  );
}

/**
 * A file the person handed over, shown as what it is: an image as the image,
 * text as text, anything else by name, type and size. Never rendered as
 * Markdown — a CSV is not prose, and a data URL is not a document.
 */
/** A stakeholder's slides: bytes, not a page, so what is offered is a save. */
function DeckFile({ node }: { node: ArtifactNode }) {
  const [state, setState] = useState<{ busy: boolean; saved: string | null; error: string | null }>({
    busy: false,
    saved: null,
    error: null,
  });
  const size = `${Math.max(1, Math.round(node.sizeBytes / 1024))} KB`;
  return (
    <div className="deck-file">
      <p className="inline-note">
        {node.title} · PowerPoint · {size}. Built from the package's deck outline: a title slide, one slide per
        outline item with the item's text as speaker notes, and the decision request.
      </p>
      <div className="button-row">
        <Button
          variant="primary"
          loading={state.busy}
          onClick={() => {
            setState({ busy: true, saved: null, error: null });
            api
              .saveArtifactFile(node.id)
              .then((result) => setState({ busy: false, saved: result.path, error: null }))
              .catch((cause) =>
                setState({ busy: false, saved: null, error: cause instanceof ApiFailure ? cause.detail.message : String(cause) }),
              );
          }}
        >
          Save slides (.pptx)
        </Button>
      </div>
      {state.saved ? <Banner tone="okay" title={`Saved to ${state.saved}`} /> : null}
      {state.error ? <Banner tone="error" title={state.error} /> : null}
    </div>
  );
}

/**
 * The completed build, as the person accepted it: one archive of the
 * attempt's workspace, named after the project. Saved, not shown — a
 * source tree is not a document.
 */
function BuildFile({ node }: { node: ArtifactNode }) {
  const [state, setState] = useState<{ busy: boolean; saved: string | null; error: string | null }>({
    busy: false,
    saved: null,
    error: null,
  });
  const size = node.sizeBytes >= 1024 * 1024 ? `${(node.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(node.sizeBytes / 1024))} KB`;
  return (
    <div className="deck-file">
      <p className="inline-note">
        {node.title} · tar.gz archive · about {size} stored. The build attempt's workspace as accepted at stage 8, without
        installed dependencies. Its bytes are what delivery review verifies.
      </p>
      <div className="button-row">
        <Button
          variant="primary"
          loading={state.busy}
          onClick={() => {
            setState({ busy: true, saved: null, error: null });
            api
              .saveArtifactFile(node.id)
              .then((result) => setState({ busy: false, saved: result.path, error: null }))
              .catch((cause) =>
                setState({ busy: false, saved: null, error: cause instanceof ApiFailure ? cause.detail.message : String(cause) }),
              );
          }}
        >
          Save the build (.tar.gz)
        </Button>
      </div>
      {state.saved ? <Banner tone="okay" title={`Saved to ${state.saved}`} /> : null}
      {state.error ? <Banner tone="error" title={state.error} /> : null}
    </div>
  );
}

function Material({ node, content }: { node: ArtifactNode; content: string }) {
  const mediaType = node.mediaType ?? "";
  const size = `${Math.max(1, Math.round(node.sizeBytes / 1024))} KB`;
  const shown = mediaType.startsWith("image/") ? (
    <figure className="material-figure">
      <img src={content} alt={node.title} />
      <figcaption>
        {node.title} · {mediaType} · {size}
      </figcaption>
    </figure>
  ) : mediaType.startsWith("text/") || mediaType === "application/json" ? (
    <div className="material-text">
      <p className="inline-note">
        {node.title} · {mediaType} · {size}
      </p>
      <pre>{content}</pre>
    </div>
  ) : (
    <p className="inline-note">
      {node.title} · {mediaType} · {size}. Kept with the project.
    </p>
  );
  return (
    <>
      {shown}
      <Reading nodeId={node.id} />
    </>
  );
}

/**
 * What the specialists are handed for this file, word for word: a
 * spreadsheet's values and structure, a PDF's text, or the note that nothing
 * here reads it. Folded, and fetched when opened, because the file itself is
 * what the person came to see; this is for checking that the part that
 * matters made it through before a draft leans on it.
 */
function Reading({ nodeId }: { nodeId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (text !== null || error !== null) return;
    api
      .materialReading(nodeId)
      .then((result) => setText(result.text))
      .catch((cause) => setError(cause instanceof ApiFailure ? cause.detail.message : String(cause)));
  };
  return (
    <details className="document-fold material-reading" onToggle={(event) => event.currentTarget.open && load()}>
      <summary className="document-fold-summary">
        <span className="document-fold-title">What the specialists can read of this</span>
      </summary>
      {error ? (
        <p className="inline-note">{error}</p>
      ) : text === null ? (
        <p className="inline-note">Loading…</p>
      ) : (
        <div className="artifact">
          <pre>{text}</pre>
        </div>
      )}
    </details>
  );
}

/**
 * A design's feedback as what it says: the direction, the note, and each
 * anchored comment with its disposition. The record is JSON, and JSON is not
 * something a person reads.
 */
type FeedbackComment = { anchor?: { testId?: string; domPath?: string }; body?: string; disposition?: string };
type FeedbackRecordJson = {
  feedback?: { direction?: string; overallNote?: string; submittedAt?: string; comments?: FeedbackComment[] };
};

function FeedbackRecord({ content }: { content: string }) {
  let record: FeedbackRecordJson | null = null;
  try {
    record = JSON.parse(content) as FeedbackRecordJson;
  } catch {
    record = null;
  }
  const feedback = record?.feedback;
  if (!feedback) return <p className="inline-note">This feedback record could not be read.</p>;
  return (
    <div className="feedback-record">
      <p>
        <strong>Direction:</strong> {feedback.direction ?? "—"}
        {feedback.submittedAt ? ` · ${new Date(feedback.submittedAt).toLocaleString()}` : ""}
      </p>
      <p>{feedback.overallNote?.trim() ? feedback.overallNote : "No overall note."}</p>
      {feedback.comments && feedback.comments.length > 0 ? (
        <ul>
          {feedback.comments.map((comment: FeedbackComment, index: number) => (
            <li key={index}>
              <span className="hash">{comment.anchor?.testId ? `#${comment.anchor.testId}` : (comment.anchor?.domPath ?? "whole design")}</span>{" "}
              {comment.body}
              {comment.disposition ? <span className="inline-note"> · {comment.disposition}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="inline-note">No anchored comments.</p>
      )}
    </div>
  );
}
