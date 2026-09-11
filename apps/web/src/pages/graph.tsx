/**
 * The artifact library.
 *
 * History is retained on the nodes themselves; the surface is the current
 * documents, read. Replaced versions stay in the footer of the one that
 * replaced them.
 */
import { EmptyState } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import { api, type ArtifactNode } from "../client.js";
import { Markdown } from "../markdown.jsx";
import { documentName, stageName } from "../components.jsx";
import { PrintButton } from "../print.jsx";

type ArtifactEdge = { childNodeId: string; sourceNodeId: string };

/** Kind plus variant: stage-5 parallel artifacts must not collapse into one row. */
function documentIdentity(node: ArtifactNode): string {
  return `${node.kind}\0${node.variant ?? ""}`;
}

function documentLabel(node: ArtifactNode): string {
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

function groupedRows(nodes: ArtifactNode[]): { stage: number; documents: ArtifactNode[] }[] {
  const byStage = new Map<number, ArtifactNode[]>();
  for (const row of currentRows(nodes)) {
    byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row]);
  }
  return [...byStage.keys()]
    .sort((left, right) => left - right)
    .map((stage) => ({
      stage,
      documents: (byStage.get(stage) ?? []).sort((left, right) =>
        documentLabel(left).localeCompare(documentLabel(right)),
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
}: {
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
  contents?: Record<string, string> | undefined;
  openedId?: string;
}) {
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
                <strong>{documentLabel(row)}</strong>
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
          <h2>{documentLabel(node)}</h2>
          <p>{kicker}</p>
        </div>
        <PrintButton node={node} content={content} />
      </header>
      <div className="document-body">
        {content === null ? (
          <p className="inline-note">Loading…</p>
        ) : content ? (
          <Markdown source={content} />
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
                    {`Built from ${documentLabel(source)} v${source.version}`}
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
