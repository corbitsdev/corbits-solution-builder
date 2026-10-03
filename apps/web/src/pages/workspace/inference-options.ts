/**
 * The Inference picker on a stage: the same provider-and-model rows Settings
 * lists, in the same order. Choosing one switches this stage onto it and
 * nothing else: the primary in Settings is unchanged.
 */
import type { Provider } from "../../client.ts";

export type InferenceOption = {
  readonly providerRowId: string;
  readonly providerLabel: string;
  readonly model: string;
  /** The offering a stage switches onto to run this row. */
  readonly offeringId: string;
  readonly label: string;
};

/** Settings' connected rows that can be run: ready, with a model enabled. */
export function inferenceOptions(providers: readonly Provider[]): InferenceOption[] {
  return providers.flatMap((provider) =>
    provider.status === "ready" && provider.selectedModel !== null && provider.selectedOfferingId !== null
      ? [
          {
            providerRowId: provider.id,
            providerLabel: provider.label,
            model: provider.selectedModel,
            offeringId: provider.selectedOfferingId,
            label: `${provider.label} · ${provider.selectedModel}`,
          },
        ]
      : [],
  );
}

/** The option the stage is running now, by provider label and model, or null. */
export function currentInference(
  active: { readonly providerLabel: string; readonly canonicalName: string } | null,
  options: readonly InferenceOption[],
): InferenceOption | null {
  if (!active) return null;
  return options.find((option) => option.providerLabel === active.providerLabel && option.model === active.canonicalName) ?? null;
}

/** Whether no connected provider serves the model the stage runs: the one it was deployed on has been removed. */
export function inferenceRemoved(
  active: { readonly canonicalName: string } | null,
  providers: readonly Provider[] | null,
): boolean {
  if (!active || !providers) return false;
  return !providers.some((provider) => provider.models.includes(active.canonicalName));
}
