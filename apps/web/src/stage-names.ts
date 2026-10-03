import { STAGE_TITLES } from "@solutions-builder/app/ledger";

/** What a stage is called on screen. Stages are named, never numbered, wherever a person reads them. */
export function stageName(stage: number | null): string {
  return stage === null ? "Not started" : ((STAGE_TITLES as Record<number, string>)[stage] ?? "Unknown stage");
}
