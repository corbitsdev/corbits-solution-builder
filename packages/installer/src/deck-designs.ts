/**
 * The per-role deck preferences, read and written under their own key in
 * the workspace tenant's `config` -- the same treatment
 * `designer-settings.ts` gives the designer's settings (#358).
 */
import type { Transport } from "@intx/hub-client";
import {
  DECK_DESIGNS_CONFIG_KEY,
  parseDeckDesignPreferences,
  type DeckDesignPreferences,
} from "@solutions-builder/app/deck-designs";
import { getTenant, patchTenant, type HubTenant } from "./hub.js";

function preferencesOf(tenant: HubTenant | null): DeckDesignPreferences {
  return parseDeckDesignPreferences(tenant?.config?.[DECK_DESIGNS_CONFIG_KEY]);
}

/** The saved preference map, empty until the first save or if it cannot be read. */
export async function readDeckDesigns(
  transport: Transport,
  tenantId: string,
): Promise<DeckDesignPreferences> {
  return preferencesOf(await getTenant(transport, tenantId));
}

/** Sets one `deck.<role>.<field>` key on the tenant's config. */
export async function saveDeckDesignPreference(
  transport: Transport,
  tenantId: string,
  key: string,
  value: unknown,
): Promise<DeckDesignPreferences> {
  const tenant = await getTenant(transport, tenantId);
  if (!tenant) throw new Error("The workspace tenant was not found.");
  const next = { ...preferencesOf(tenant), [key]: value };
  await patchTenant(transport, tenantId, {
    config: { ...(tenant.config ?? {}), [DECK_DESIGNS_CONFIG_KEY]: next },
  });
  return next;
}
