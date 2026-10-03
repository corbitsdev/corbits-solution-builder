import { STAGE_TITLES, type Stage } from "@solutions-builder/app/ledger";

/** What each stage is called on screen. Stages are named, never numbered, wherever a person reads them. */
export function stageName(stage: number | null): string {
  return stage === null ? "Not started" : (STAGE_TITLES[stage as Stage] ?? `Stage ${stage}`);
}
