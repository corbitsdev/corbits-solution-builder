/**
 * Drag/keyboard-resizable width for the split workspace's chat column.
 *
 * The chosen width persists in localStorage; `null` means "use the CSS
 * default" (minmax(420px, min(40%, 640px)) — see workspace-layout.css). The
 * splitter still needs a real pixel number to report as aria-valuenow, so
 * a ResizeObserver on the conversation pane (the splitter's previous
 * sibling) tracks the rendered width whether or not it's been overridden.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

const STORAGE_KEY = "sb.panes.chat-width";
export const PANES_MIN_WIDTH = 320;
export const PANES_MAX_WIDTH = 720;

function clamp(width: number): number {
  return Math.min(PANES_MAX_WIDTH, Math.max(PANES_MIN_WIDTH, Math.round(width)));
}

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : null;
  } catch {
    return null;
  }
}

function writeStored(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Storage unavailable (private mode, quota, disabled) — the width still
    // applies for this render, it just won't survive a reload.
  }
}

export type PanesWidth = {
  /** Inline CSS custom property to spread onto the `.panes` element. */
  readonly style: { "--panes-chat-w"?: string };
  readonly separatorRef: (node: HTMLDivElement | null) => void;
  readonly valueNow: number;
  readonly min: number;
  readonly max: number;
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
};

export function usePanesWidth(): PanesWidth {
  const [width, setWidth] = useState<number | null>(() => readStored());
  const [measured, setMeasured] = useState(PANES_MIN_WIDTH);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const separatorRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
  }, []);

  useEffect(() => {
    const conv = nodeRef.current?.previousElementSibling;
    if (!conv || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setMeasured(Math.round(entry.contentRect.width));
    });
    observer.observe(conv);
    return () => observer.disconnect();
  }, []);

  const commit = useCallback((next: number) => {
    const clamped = clamp(next);
    setWidth(clamped);
    writeStored(clamped);
  }, []);

  const onDoubleClick = useCallback(() => {
    setWidth(null);
    writeStored(null);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const conv = nodeRef.current?.previousElementSibling;
    const startWidth = conv instanceof HTMLElement ? conv.getBoundingClientRect().width : measured;
    dragRef.current = { startX: event.clientX, startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [measured]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    commit(dragRef.current.startWidth + (event.clientX - dragRef.current.startX));
  }, [commit]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    const base = width ?? measured;
    if (event.key === "ArrowLeft") {
      commit(base - step);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      commit(base + step);
      event.preventDefault();
    } else if (event.key === "Home") {
      commit(PANES_MIN_WIDTH);
      event.preventDefault();
    } else if (event.key === "End") {
      commit(PANES_MAX_WIDTH);
      event.preventDefault();
    }
  }, [commit, measured, width]);

  return {
    style: width !== null ? { "--panes-chat-w": `${width}px` } : {},
    separatorRef,
    valueNow: width ?? measured,
    min: PANES_MIN_WIDTH,
    max: PANES_MAX_WIDTH,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
    onDoubleClick,
  };
}
