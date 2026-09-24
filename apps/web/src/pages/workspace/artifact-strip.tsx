/**
 * The right pane's artifact strip: one tab per artifact lineage across the
 * project — the icon follows the artifact's kind, a dot marks the current
 * stage's live lineage — and, under it, the selected artifact's version
 * chips. Presentational; the model comes from `useProjectArtifacts`.
 */
import type { ReactNode } from "react";
import { Tabs } from "@corbits/react-ui";
import {
  Component,
  DollarSign,
  FileCheck2,
  FileText,
  ListChecks,
  MessageSquare,
  Package,
  Paperclip,
  Presentation,
  Terminal,
} from "lucide-react";
import type { ArtifactTab } from "./use-project-artifacts.ts";

/** Tab glyphs follow the artifact kind, not the name. */
const KIND_ICON: Record<string, ReactNode> = {
  design_artifact: <Component size={13} aria-hidden="true" />,
  audience_package: <Presentation size={13} aria-hidden="true" />,
  product_requirements: <ListChecks size={13} aria-hidden="true" />,
  engineering_review: <FileCheck2 size={13} aria-hidden="true" />,
  build_review: <FileCheck2 size={13} aria-hidden="true" />,
  delivery_verification: <FileCheck2 size={13} aria-hidden="true" />,
  cost_approval: <DollarSign size={13} aria-hidden="true" />,
  build_packet: <Package size={13} aria-hidden="true" />,
  delivery_manifest: <Package size={13} aria-hidden="true" />,
  build_evidence: <Terminal size={13} aria-hidden="true" />,
  design_feedback: <MessageSquare size={13} aria-hidden="true" />,
  source_material: <Paperclip size={13} aria-hidden="true" />,
};

export function ArtifactStrip({
  tabs,
  selectedKey,
  onSelect,
}: {
  tabs: ArtifactTab[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (tabs.length === 0 || selectedKey === null) return null;
  return (
    <Tabs
      className="artifact-strip-tabs"
      scrollable
      label="Project artifacts"
      active={selectedKey}
      onChange={onSelect}
      tabs={tabs.map((tab) => ({
        id: tab.key,
        label: tab.label,
        icon: KIND_ICON[tab.kind] ?? <FileText size={13} aria-hidden="true" />,
        marker: tab.live ? <span className="artifact-strip-live" aria-label="Current stage" /> : undefined,
      }))}
    >
      {() => null}
    </Tabs>
  );
}

/** The selected artifact's versions: quiet chips with prev/next paging and
 *  the head's timestamp — the superseded-version gate reads off this. */
export function VersionStrip({
  tab,
  activeId,
  onSelect,
}: {
  tab: ArtifactTab;
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const versions = tab.versions;
  if (versions.length === 0) return null;
  const index = versions.findIndex((v) => v.id === activeId);
  const active = versions[index] ?? versions.at(-1)!;
  const step = (delta: number) => {
    const next = versions[index + delta];
    if (next) onSelect(next.id);
  };
  return (
    <div className="version-strip">
      <button
        type="button"
        className="ver-nav"
        disabled={index <= 0}
        title="Previous version"
        aria-label="Previous version"
        onClick={() => step(-1)}
      >
        ‹
      </button>
      {versions.map((v, i) => (
        // The lineage's position, not `v.version` — a superseded draft is
        // superseded by stamping a fresh artifact (`sb.supersedes`), so each
        // node's own `version` field is 1 regardless of where it sits in the
        // chain; the chips would otherwise all read "v1".
        <button
          key={v.id}
          type="button"
          className={v.id === active.id ? "ver on" : "ver"}
          onClick={() => onSelect(v.id)}
          title={v.supersededByNodeId ? `v${i + 1} · superseded` : `v${i + 1}`}
        >
          v{i + 1}
        </button>
      ))}
      <button
        type="button"
        className="ver-nav"
        disabled={index >= versions.length - 1}
        title="Next version"
        aria-label="Next version"
        onClick={() => step(1)}
      >
        ›
      </button>
      <span className="version-note">
        {new Date(active.createdAt).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
        {active.supersededByNodeId ? " · superseded" : ""}
      </span>
    </div>
  );
}
