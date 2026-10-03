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
import { documentMediaType, versionIdFor } from "@solutions-builder/app/artifact-graph";
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
    refs.set(draft.id, { version: node?.position ?? null, nodeId: node?.id ?? null, noun });
  });
  return refs;
}

/**
 * A stage document the specialist keeps in one artifact: every version of
 * it, in version order. Each node's id names its exact version, so reading
 * it reads that version.
 */
export function documentVersions(document: StageWorkArtifact, stage: number, kind: string, title: string): ArtifactNode[] {
  return document.versions.map((version, index) => ({
    id: versionIdFor(document.id, version.version),
    kind,
    variant: null,
    stage,
    title,
    version: version.version,
    position: version.version,
    artifactId: document.id,
    contentHash: versionIdFor(document.id, version.version),
    mediaType: documentMediaType(kind),
    createdAt: version.createdAt,
    supersededByNodeId: index + 1 < document.versions.length ? versionIdFor(document.id, document.versions[index + 1]!.version) : null,
    provenance: { producer: "agent" },
    contentSha256: version.contentSha256,
  }));
}
