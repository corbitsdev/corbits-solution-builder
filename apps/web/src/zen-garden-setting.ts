/**
 * Whether the zen garden shows while the interface works. On unless the
 * person turns it off in Settings; when off, the same live activity shows
 * as one line in the workspace's composer instead.
 */
import { useStoredPreference, writeStoredPreference } from "./stored-preference.ts";

const ZEN_GARDEN_KEY = "solutions-builder-zen-garden";

export type ZenGardenChoice = "on" | "off";

const parseZenGarden = (raw: string): ZenGardenChoice | null => (raw === "on" || raw === "off" ? raw : null);

export function useZenGarden(): ZenGardenChoice {
  return useStoredPreference(ZEN_GARDEN_KEY, parseZenGarden, "on");
}

export function writeZenGarden(choice: ZenGardenChoice): void {
  writeStoredPreference(ZEN_GARDEN_KEY, choice);
}
