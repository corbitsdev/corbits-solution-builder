/**
 * The per-role deck preferences, read and written as a hub asset on the
 * workspace tenant — the same treatment `designer-settings.ts` gives the
 * designer's settings: one asset, kind `deck-designs`, a single JSON file.
 */
import type { Transport } from "@intx/hub-client";
import {
  DECK_DESIGNS_ASSET_KIND,
  DECK_DESIGNS_ASSET_NAME,
  DECK_DESIGNS_PATH,
  parseDeckDesignPreferences,
  type DeckDesignPreferences,
} from "@solutions-builder/app/deck-designs";
import { assetsFor, readWorkflowSourceBlob, writeWorkflowSourceTree } from "./hub.js";

async function deckDesignsAssetId(transport: Transport, tenantId: string): Promise<string | null> {
  const found = (await assetsFor(transport, tenantId).list(DECK_DESIGNS_ASSET_KIND)).find(
    (asset) => asset.name === DECK_DESIGNS_ASSET_NAME,
  );
  return found?.id ?? null;
}

/** The saved preference map, empty until the first save or if it cannot be read. */
export async function readDeckDesigns(
  transport: Transport,
  tenantId: string,
): Promise<DeckDesignPreferences> {
  const assetId = await deckDesignsAssetId(transport, tenantId);
  if (!assetId) return {};
  const raw = await readWorkflowSourceBlob(transport, tenantId, assetId, DECK_DESIGNS_PATH);
  return raw === null ? {} : parseDeckDesignPreferences(JSON.parse(raw));
}

/** Sets one `deck.<role>.<field>` key on the tenant's asset. */
export async function saveDeckDesignPreference(
  transport: Transport,
  tenantId: string,
  key: string,
  value: unknown,
): Promise<DeckDesignPreferences> {
  const assets = assetsFor(transport, tenantId);
  let assetId = await deckDesignsAssetId(transport, tenantId);
  const current = assetId
    ? parseDeckDesignPreferences(
        JSON.parse((await readWorkflowSourceBlob(transport, tenantId, assetId, DECK_DESIGNS_PATH)) ?? "{}"),
      )
    : {};
  const next = { ...current, [key]: value };
  if (!assetId) {
    assetId = (
      await assets.create({
        kind: DECK_DESIGNS_ASSET_KIND,
        name: DECK_DESIGNS_ASSET_NAME,
        displayName: "Deck designs",
      })
    ).id;
  }
  await writeWorkflowSourceTree(transport, tenantId, {
    assetId,
    files: { [DECK_DESIGNS_PATH]: `${JSON.stringify(next, null, 2)}\n` },
    message: "Update deck designs",
  });
  return next;
}
