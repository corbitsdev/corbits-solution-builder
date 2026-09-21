/**
 * Workspace default model via offering priority (CL-8781).
 *
 * The workspace default is the lowest-priority enabled offering in the
 * resolved catalog — never provider-list order, never a sibling-disable pin.
 * This module holds the pure patch computation plus the guarded apply step
 * that makes `claude-opus-5` the default on fresh and migrated installs
 * without clobbering a user-customized default.
 */
import type { Transport } from "@intx/hub-client";
import { catalogFor, type HubOffering } from "./hub.js";

/** The model the workspace drafts with unless the catalog says otherwise. */
export const WORKSPACE_DEFAULT_MODEL = "claude-opus-5";

/**
 * The default this change migrates away from: the pre-8781 seed snapshot
 * leads with `claude-sonnet-5` at priority 0. A workspace whose current
 * default still resolves to this model has never customized its default, so
 * the migration may move it; anything else is the user's and is left alone.
 */
export const LEGACY_SEED_DEFAULT_MODEL = "claude-sonnet-5";

/** The offering fields the default computation reads. Hub rows carry these. */
export type DefaultableOffering = Pick<HubOffering, "id" | "modelId" | "priority" | "disabled">;

/** One `PATCH /catalog/offerings/:id` payload: a priority move, nothing else. */
export type MakeDefaultPatch = { id: string; priority: number };

export type MakeDefaultRefusal = "restricted" | "unknown-target";

/**
 * Refuses to make a model the default: its offering is restricted
 * (disabled), or no offering resolves to it at all.
 */
export class MakeDefaultError extends Error {
  readonly code: MakeDefaultRefusal;

  constructor(code: MakeDefaultRefusal, modelId: string) {
    super(
      code === "restricted"
        ? `cannot make model ${modelId} the default: its offering is restricted`
        : `cannot make model ${modelId} the default: no offering resolves to it`,
    );
    this.name = "MakeDefaultError";
    this.code = code;
  }
}

function enabledByPriority(offerings: readonly DefaultableOffering[]): DefaultableOffering[] {
  return offerings.filter((offering) => !offering.disabled).sort((a, b) => a.priority - b.priority);
}

/**
 * Computes the minimal `PATCH /catalog/offerings/:id` payloads that make
 * `targetModelId` the workspace default: the current default is demoted to
 * the target's priority and the target is promoted to the current default's.
 * Exactly two patches, priority fields only — disabled flags are never
 * touched, and an already-default target yields the empty set.
 *
 * @throws {MakeDefaultError} `restricted` when the target's offering is
 * disabled, `unknown-target` when no offering resolves to the target.
 */
export function computeMakeDefaultPatches(
  resolvedOfferings: readonly DefaultableOffering[],
  targetModelId: string,
): MakeDefaultPatch[] {
  const enabled = enabledByPriority(resolvedOfferings);
  const target = enabled.find((offering) => offering.modelId === targetModelId);
  if (!target) {
    if (resolvedOfferings.some((offering) => offering.modelId === targetModelId)) {
      throw new MakeDefaultError("restricted", targetModelId);
    }
    throw new MakeDefaultError("unknown-target", targetModelId);
  }
  const current = enabled[0]!;
  // Already the default (or tied for it — swapping equal priorities is a
  // no-op, so the minimal set is empty either way).
  if (current.modelId === targetModelId || current.priority === target.priority) return [];
  return [
    { id: target.id, priority: current.priority },
    { id: current.id, priority: target.priority },
  ];
}

/**
 * Makes `claude-opus-5` the workspace default, but only when the current
 * default is still the legacy seed default (`claude-sonnet-5` at the head of
 * the priority order). A workspace whose default resolves to anything else
 * has a user-customized default and is left alone; a workspace with no opus
 * offering, or only a restricted one, is left alone too. Idempotent: after a
 * successful run the default is opus, so the guard never fires twice.
 */
export async function ensureOpusDefault(
  transport: Transport,
  workspaceTenantId: string,
): Promise<{ patched: boolean; patches: MakeDefaultPatch[] }> {
  const catalog = catalogFor(transport, workspaceTenantId);
  const [models, offerings] = await Promise.all([catalog.models(), catalog.offerings()]);
  const opus = models.find((model) => model.canonicalName === WORKSPACE_DEFAULT_MODEL);
  if (!opus) return { patched: false, patches: [] };
  const current = enabledByPriority(offerings)[0];
  if (!current) return { patched: false, patches: [] };
  const currentModel = models.find((model) => model.id === current.modelId);
  if (currentModel?.canonicalName !== LEGACY_SEED_DEFAULT_MODEL) return { patched: false, patches: [] };
  let patches: MakeDefaultPatch[];
  try {
    patches = computeMakeDefaultPatches(offerings, opus.id);
  } catch (cause) {
    // Opus is restricted or unresolvable: the catalog stays as the user (or
    // the seed) left it. Transport failures still propagate.
    if (cause instanceof MakeDefaultError) return { patched: false, patches: [] };
    throw cause;
  }
  for (const patch of patches) {
    await catalog.patchOffering(patch.id, { priority: patch.priority });
  }
  return { patched: patches.length > 0, patches };
}
