/**
 * The Inference picker on a stage: the same provider-and-model rows Settings
 * lists, in the same order. Choosing one is the same as dragging that row to
 * the top there -- it becomes the default -- and this stage switches onto it.
 */
import type { Provider } from "../../client.ts";

export type InferenceOption = {
  /** The model-provider row id, what `reorderProviders` orders by. */
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

/** The settings order with `chosen` moved to the top. */
export function orderLeadingWith(providers: readonly Provider[], chosen: string): string[] {
  return [chosen, ...providers.map((provider) => provider.id).filter((id) => id !== chosen)];
}
