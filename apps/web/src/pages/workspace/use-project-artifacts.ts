/**
 * The artifact strip's model: one tab per artifact lineage — `(stage, kind,
 * variant)`, which keeps stage 5's audience decks and stage 8's build
 * attempts as separate tabs while a document's versions share one. The
 * current stage's unpersisted draft joins its lineage as the pending head;
 * with no lineage yet it is a tab of its own.
 *
 * Selection defaults to the current stage's draft document and follows the
 * stage as it advances. Selecting another artifact switches the right pane
 * to it read-only — only the current stage's draft lineage can be submitted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, STAGE_DRAFT_KIND, type ArtifactNode } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { documentName, stageName } from "../../components.jsx";

/** Internal bookkeeping kinds never surface as tabs — the strip lists work
 *  product, not plumbing. */
export const INTERNAL_KINDS = new Set([
  "withdrawn_turns",
  "material_reading",
  "deck_template",
  "deck_settings",
  "deck_design_document",
  "deck_design_reading",
]);

export type ArtifactTab = {
  /** `${stage}:${kind}:${variant}` — stable across versions. */
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly stage: number;
  /** The lineage's head — superseded versions never get a tab. */
  readonly head: ArtifactNode;
  readonly versions: ArtifactNode[];
  /** The current stage's lineage — the live marker in the strip. */
  readonly live: boolean;
};

export type ProjectArtifacts = {
  readonly tabs: ArtifactTab[];
  readonly selected: ArtifactTab | null;
  readonly select: (key: string | null) => void;
  /** Selects a stage's newest lineage — the done-segment stepper's way in. */
  readonly selectStage: (stage: number) => void;
  /** The selected tab's active version — the head unless an older version
   *  was paged to. */
  readonly activeNode: ArtifactNode | null;
  readonly activeContent: string;
  /** A version newer than the selected one exists. */
  readonly newerVersion: ArtifactNode | null;
  readonly selectVersion: (id: string | null) => void;
  /** Opens one version wherever it is: the tab holding it is selected as
   *  well, so a draft line in the conversation (#158) shows its version even
   *  while another document is up. */
  readonly openVersion: (id: string) => void;
  /** The selection is the current stage's draft lineage — the only pane the
   *  gate may act on. */
  readonly isStageDraft: boolean;
};

export function useProjectArtifacts(
  tenantId: string,
  stage: number,
  nodes: readonly ArtifactNode[],
  draftMessage: ChatMessage | null,
): ProjectArtifacts {
  const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
  const draftBody = draftMessage?.body ?? null;
  const [draftDigest, setDraftDigest] = useState<{ body: string; sha256: string } | null>(null);
  useEffect(() => {
    if (draftBody === null) return;
    let cancelled = false;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(draftBody)).then((buffer) => {
      const sha256 = [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!cancelled) setDraftDigest({ body: draftBody, sha256 });
    });
    return () => {
      cancelled = true;
    };
  }, [draftBody]);
  // The specialist's latest unpersisted reply stands in as the next version
  // of its stage's draft lineage — nothing writes an artifact for a stage's
  // draft before it is approved.
  const draftNode: ArtifactNode | null = useMemo(() => {
    if (!draftMessage || draftKind === null) return null;
    // A saved draft's own version is 1 wherever it sits, so the newest is
    // found by when it was written.
    const head = nodes
      .filter((node) => node.stage === stage && node.kind === draftKind)
      .sort((a, b) => a.version - b.version || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .at(-1);
    // Opening the reply's review saves it as a version just after it lands;
    // once saved, the reply is that version, not one past it. Matched on the
    // content's digest: the hub's timestamps do not all share one clock.
    if (head?.contentSha256 && draftDigest?.body === draftMessage.body && head.contentSha256 === draftDigest.sha256) return null;
    return {
      id: `reply:${draftMessage.id}`,
      kind: draftKind,
      variant: null,
      stage,
      title: stageName(stage),
      version: (head?.version ?? 0) + 1,
      artifactId: `reply:${draftMessage.id}`,
      contentHash: "",
      sizeBytes: draftMessage.body.length,
      mediaType: "text/markdown",
      createdAt: draftMessage.at,
      supersededByNodeId: null,
      provenance: { producer: "specialist" },
    };
  }, [draftMessage, draftKind, stage, nodes, draftDigest]);
  const tabs = useMemo<ArtifactTab[]>(() => {
    const groups = new Map<string, ArtifactNode[]>();
    for (const node of nodes) {
      if (INTERNAL_KINDS.has(node.kind)) continue;
      const key = `${node.stage}:${node.kind}:${node.variant ?? ""}`;
      const group = groups.get(key);
      if (group) group.push(node);
      else groups.set(key, [node]);
    }
    if (draftNode) {
      const key = `${draftNode.stage}:${draftNode.kind}:`;
      const group = groups.get(key);
      if (group) group.push(draftNode);
      else groups.set(key, [draftNode]);
    }
    const draftKind = STAGE_DRAFT_KIND[stage] ?? null;
    return [...groups.entries()]
      .map(([key, versions]) => {
        const sorted = [...versions].sort(
          (a, b) => a.version - b.version || Date.parse(a.createdAt) - Date.parse(b.createdAt),
        );
        // The newest non-superseded node, not the first — a lineage written
        // before every write chained `sb.supersedes` can have more than one
        // node with no successor; the most recent of those is still the
        // right head to show, never the oldest.
        const head = sorted.filter((v) => v.supersededByNodeId === null).at(-1) ?? sorted.at(-1)!;
        const label =
          head.kind === "source_material"
            ? head.title
            : versions.length > 1 || head.variant
              ? head.variant
                ? `${documentName(head.kind)} · ${head.variant}`
                : documentName(head.kind)
              : documentName(head.kind);
        return {
          key,
          label: label === "Document" ? head.title : label,
          kind: head.kind,
          stage: head.stage,
          head,
          versions: sorted,
          live: head.stage === stage && head.kind === draftKind,
        };
      })
      .sort((a, b) => a.stage - b.stage || Date.parse(a.head.createdAt) - Date.parse(b.head.createdAt));
  }, [nodes, draftNode, stage, draftKind]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    setSelectedKey(null);
  }, [stage]);

  const draftKey = `${stage}:${STAGE_DRAFT_KIND[stage] ?? ""}:`;
  const selected = tabs.find((tab) => tab.key === (selectedKey ?? draftKey)) ?? tabs.find((tab) => tab.live) ?? null;

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  // A new tab starts at its head -- unless it was selected for one of its
  // own versions (`openVersion`), which stays.
  useEffect(() => {
    setSelectedVersionId((current) => (current !== null && selected?.versions.some((v) => v.id === current) ? current : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key]);
  const openVersion = useCallback(
    (id: string) => {
      const tab = tabs.find((entry) => entry.versions.some((version) => version.id === id));
      if (tab) setSelectedKey(tab.key);
      setSelectedVersionId(id);
    },
    [tabs],
  );

  const activeNode = selected
    ? (selected.versions.find((version) => version.id === selectedVersionId) ?? selected.versions.at(-1) ?? null)
    : null;
  const newerVersion =
    selected && activeNode ? selected.versions.find((v) => v.version > activeNode.version) ?? null : null;

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
    // Nothing of the previous document while this one loads: a reader that
    // hands a sandboxed frame one document and then another never paints
    // the second (see design.tsx), and the stale text was never this
    // document's anyway.
    setActiveContent("");
    let cancelled = false;
    void api
      .artifactContent(tenantId, activeNode.id)
      .then((result) => {
        if (!cancelled) setActiveContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setActiveContent("_This version could not be read. It is still on disk — try again._");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNode?.id, tenantId]);

  return {
    tabs,
    selected,
    select: setSelectedKey,
    selectStage: (forStage) => {
      // The stage's own document first -- a stage 4 click means the design,
      // not the imported conversation or a package recorded at stage 4 --
      // then whatever lineage that stage does have.
      const atStage = tabs.filter((t) => t.stage === forStage);
      const own = STAGE_DRAFT_KIND[forStage];
      const tab = (own ? atStage.find((t) => t.kind === own) : undefined) ?? atStage.at(-1);
      if (tab) setSelectedKey(tab.key);
    },
    activeNode,
    activeContent,
    newerVersion,
    selectVersion: setSelectedVersionId,
    openVersion,
    isStageDraft: selected?.key === draftKey,
  };
}
