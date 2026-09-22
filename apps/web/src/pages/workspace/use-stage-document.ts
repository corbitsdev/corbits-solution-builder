/**
 * The current stage's document versions: this stage's approved versions plus
 * the specialist's latest unpersisted reply as the version being read right
 * now — the same stand-in `DesignPanel` uses for stage 4's not-yet-approved
 * mockup, since nothing writes an artifact for a stage's draft before it is
 * approved.
 */
import { useEffect, useMemo, useState } from "react";
import { api, STAGE_DRAFT_KIND, type ArtifactNode } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { stageName } from "../../components.jsx";

/** Stands in for a version that would not load, so it never reads as empty. */
const UNREADABLE = "_This version could not be read. It is still on disk — try again._";

export type StageDocumentState = {
  /** The artifact kind this stage's approved versions live under. */
  readonly draftKind: string | null;
  readonly versions: ArtifactNode[];
  readonly activeNode: ArtifactNode | null;
  /** A version newer than the selected one exists — the version pager's cue. */
  readonly newerVersion: ArtifactNode | null;
  readonly activeContent: string;
  readonly selectVersion: (id: string | null) => void;
  /** The synthetic node standing in for the unpersisted draft reply. */
  readonly draftNode: ArtifactNode | null;
};

export function useStageDocument(
  tenantId: string,
  stage: number,
  nodes: readonly ArtifactNode[],
  draftMessage: ChatMessage | null,
): StageDocumentState {
  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  const approvedVersions = useMemo(
    () =>
      nodes
        .filter((node) => node.stage === stage && draftKind !== null && node.kind === draftKind)
        .sort((left, right) => left.version - right.version),
    [nodes, stage, draftKind],
  );
  const draftNode: ArtifactNode | null = useMemo(() => {
    if (!draftMessage || draftKind === null) return null;
    return {
      id: `reply:${draftMessage.id}`,
      kind: draftKind,
      variant: null,
      stage,
      title: stageName(stage),
      version: (approvedVersions.at(-1)?.version ?? 0) + 1,
      artifactId: `reply:${draftMessage.id}`,
      contentHash: "",
      sizeBytes: draftMessage.body.length,
      mediaType: "text/markdown",
      createdAt: draftMessage.at,
      supersededByNodeId: null,
      provenance: { producer: "specialist" },
    };
  }, [draftMessage, draftKind, stage, approvedVersions]);
  const versions = useMemo(() => (draftNode ? [...approvedVersions, draftNode] : approvedVersions), [approvedVersions, draftNode]);

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedVersionId(null);
  }, [stage]);

  const activeNode = versions.find((version) => version.id === selectedVersionId) ?? versions.at(-1) ?? null;
  const newerVersion = activeNode ? versions.find((version) => version.version > activeNode.version) ?? null : null;

  const [activeContent, setActiveContent] = useState("");
  useEffect(() => {
    if (!activeNode) {
      setActiveContent("");
      return;
    }
    if (activeNode.id === draftNode?.id) {
      setActiveContent(draftMessage?.body ?? "");
      return;
    }
    let cancelled = false;
    void api
      .artifactContent(tenantId, activeNode.id)
      .then((result) => {
        if (!cancelled) setActiveContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setActiveContent(UNREADABLE);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNode?.id, tenantId]);

  return { draftKind, versions, activeNode, newerVersion, activeContent, selectVersion: setSelectedVersionId, draftNode };
}
