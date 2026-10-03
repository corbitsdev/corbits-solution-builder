/**
 * Whether the zen garden shows while the interface works. On unless the
 * person turns it off in Settings; when off, the same live activity shows
 * as one line in the workspace's composer instead. Kept in this browser's
 * storage, like the strip's height: a preference for this window.
 */
import { useSyncExternalStore } from "react";

export const ZEN_GARDEN_KEY = "solutions-builder-zen-garden";

const listeners = new Set<() => void>();
let current: boolean | null = null;

export function readZenGarden(): boolean {
  if (current === null) {
    try {
      current = localStorage.getItem(ZEN_GARDEN_KEY) !== "off";
    } catch {
      current = true;
    }
  }
  return current;
}

export function writeZenGarden(on: boolean): void {
  current = on;
  try {
    if (on) localStorage.removeItem(ZEN_GARDEN_KEY);
    else localStorage.setItem(ZEN_GARDEN_KEY, "off");
  } catch {
    // Blocked storage: the choice still holds until the window closes.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Another window changed it: read it again.
  const onStorage = () => {
    current = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useZenGarden(): boolean {
  return useSyncExternalStore(subscribe, readZenGarden, () => true);
}
