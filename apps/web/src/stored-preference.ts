/**
 * A person's preference in this browser, read live by every component that
 * shows it and by other windows through the `storage` event. When storage is
 * unavailable the choice lives in memory until the window closes.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const inMemory = new Map<string, string | null>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStored(key: string): string | null {
  if (inMemory.has(key)) return inMemory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn(`Browser storage is unavailable; "${key}" keeps its default for this window.`, error);
    inMemory.set(key, null);
    return null;
  }
}

export function writeStoredPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    inMemory.delete(key);
  } catch (error) {
    console.warn(`Browser storage refused "${key}"; the choice lasts until this window closes.`, error);
    inMemory.set(key, value);
  }
  for (const listener of listeners) listener();
}

/** The stored value as `parse` reads it, or `fallback` when nothing valid is stored. */
export function useStoredPreference<T extends string>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  const read = () => {
    const raw = readStored(key);
    return (raw === null ? null : parse(raw)) ?? fallback;
  };
  return useSyncExternalStore(subscribe, read, () => fallback);
}
