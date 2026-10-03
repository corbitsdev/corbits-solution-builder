/**
 * Which version each draft reply in a stage's thread became (#158). The
 * chat shows a draft as one line naming its version -- "Drafted v2 of the
 * problem brief" -- and the document pane holds the draft itself; this is
 * the record the line is read from.
 *
 * Mail keeps no link from a reply to the version persisted from it, so the
 * pairing is by time: a version written after a draft reply and before the
 * next one came from that reply. The latest reply is the pane's own
 * unpersisted head (`use-project-artifacts.ts`'s `reply:<id>` node) when
 * that node is in the lineage, so the line opens the same version the pane
 * shows by default. A draft with no version found still gets a line, with
 * nothing to open: the reply is a draft whether or not a review has
 * persisted it yet.
 */
import { versionIdFor } from "@solutions-builder/app/artifact-graph";
import type { ArtifactNode, StageWorkArtifact } from "../../client.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import { isSubstantialDraft } from "./guidance.ts";

export type DraftRef = {
  readonly version: number | null;
  readonly nodeId: string | null;
  /** What the document is called, lower case: "problem brief". */
  readonly noun: string;
};

const EMPTY: ReadonlyMap<string, DraftRef> = new Map();

/** The reply id of a lineage's unpersisted head, or null for a persisted node. */
function replyIdOf(node: ArtifactNode): string | null {
  return node.id.startsWith("reply:") ? node.id.slice("reply:".length) : null;
}

/**
 * A `DraftRef` for every specialist reply in `messages` that reads as a
 * draft, keyed by message id. `versions` is the stage's draft lineage,
 * oldest first, persisted nodes and the unpersisted head alike.
 */
export function draftReferences(
  messages: readonly ChatMessage[],
  versions: readonly ArtifactNode[],
  noun: string,
): ReadonlyMap<string, DraftRef> {
  const drafts = messages
    .filter((message) => message.author === "agent" && isSubstantialDraft(message.body))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (drafts.length === 0) return EMPTY;
  const heads = new Map(versions.flatMap((node) => (replyIdOf(node) ? [[replyIdOf(node)!, node] as const] : [])));
  const persisted = versions
    .filter((node) => replyIdOf(node) === null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const refs = new Map<string, DraftRef>();
  drafts.forEach((draft, index) => {
    const head = heads.get(draft.id);
    const from = Date.parse(draft.at);
    const until = index + 1 < drafts.length ? Date.parse(drafts[index + 1]!.at) : Number.POSITIVE_INFINITY;
    const node =
      head ??
      persisted.find((entry) => {
        const at = Date.parse(entry.createdAt);
        return at >= from && at < until;
      }) ??
      null;
    refs.set(draft.id, { version: node?.version ?? null, nodeId: node?.id ?? null, noun });
  });
  return refs;
}

/** One version of a stage document kept in an artifact, and the reply that left it there (null for none). */
export type DocumentVersion = { readonly node: ArtifactNode; readonly replyId: string | null };

/**
 * A stage document the specialist keeps in one artifact, as the versions the
 * person saw, oldest first: the version each reply left it at -- a reply's
 * earlier writes are not versions -- then the current one when no reply has
 * left it yet (a write still in progress, or an earlier version restored).
 * A version written after one reply and by the next is the next reply's.
 * Each node's id names its exact version, so reading it reads that version.
 */
export function documentVersions(
  messages: readonly ChatMessage[],
  document: StageWorkArtifact,
  stage: number,
  kind: string,
  title: string,
): DocumentVersion[] {
  const picked: { version: StageWorkArtifact["versions"][number]; replyId: string | null }[] = [];
  let from = Number.NEGATIVE_INFINITY;
  for (const reply of messages.filter((message) => message.author === "agent")) {
    const until = Date.parse(reply.at);
    const left = document.versions.filter((entry) => Date.parse(entry.createdAt) > from && Date.parse(entry.createdAt) <= until).at(-1);
    if (left) picked.push({ version: left, replyId: reply.id });
    from = until;
  }
  const current = document.versions.at(-1);
  if (current && picked.at(-1)?.version.version !== current.version) picked.push({ version: current, replyId: null });
  return picked.map(({ version, replyId }, index) => ({
    replyId,
    node: {
      id: versionIdFor(document.id, version.version),
      kind,
      variant: null,
      stage,
      title,
      version: version.version,
      artifactId: document.id,
      contentHash: versionIdFor(document.id, version.version),
      mediaType: "text/markdown",
      createdAt: version.createdAt,
      supersededByNodeId: index + 1 < picked.length ? versionIdFor(document.id, picked[index + 1]!.version.version) : null,
      provenance: { producer: "agent" },
      contentSha256: version.contentSha256,
    },
  }));
}
