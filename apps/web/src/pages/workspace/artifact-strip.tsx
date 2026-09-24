/**
 * The right pane's artifact strip: one tab per artifact lineage across the
 * project — the icon follows the artifact's kind, a dot marks the current
 * stage's live lineage — and, under it, the selected artifact's version
 * chips. Presentational; the model comes from `useProjectArtifacts`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tabs } from "@corbits/react-ui";
import {
  ChevronLeft,
  ChevronRight,
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

/** Which edges of a scrolling strip still hide tabs. Pure, so the rule the
 *  edge controls follow is testable without a DOM. */
export function stripOverflow(metrics: {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}): { readonly left: boolean; readonly right: boolean } {
  return {
    left: metrics.scrollLeft > 1,
    right: metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - 1,
  };
}

/**
 * A project soon has more lineages than the strip is wide, and the library's
 * scrollable tab list hides its scrollbar and only fades the overflowing
 * edge -- a person looking for the Design saw the strip end at "Chosen
 * approach" and took that for all there was. So: a control at each edge
 * that still hides tabs, which scrolls them into view, and the selected tab
 * brought into view whenever the selection changes, the initial one
 * included.
 */
export function ArtifactStrip({
  tabs,
  selectedKey,
  onSelect,
}: {
  tabs: ArtifactTab[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const list = () => scroller.current?.querySelector<HTMLElement>('[role="tablist"]') ?? null;

  useEffect(() => {
    const el = list();
    if (!el) return;
    const update = () => {
      const next = stripOverflow(el);
      setOverflow((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [tabs.length]);

  useEffect(() => {
    const selected = list()?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    selected?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [selectedKey, tabs.length]);

  if (tabs.length === 0 || selectedKey === null) return null;
  const scrollBy = (direction: -1 | 1) => {
    const el = list();
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <div ref={scroller} className="artifact-strip-scroller">
      <button
        type="button"
        className="artifact-strip-scroll is-left"
        hidden={!overflow.left}
        aria-label="Show earlier artifacts"
        onClick={() => scrollBy(-1)}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
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
      <button
        type="button"
        className="artifact-strip-scroll is-right"
        hidden={!overflow.right}
        aria-label="Show more artifacts"
        onClick={() => scrollBy(1)}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
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
