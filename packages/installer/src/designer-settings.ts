/**
 * The designer's settings, read and written as a hub asset on the workspace
 * tenant, the way `skill-assets.ts` treats a curated skill: one asset, kind
 * `designer-settings`, holding a single JSON file at its main ref.
 */
import type { Transport } from "@intx/hub-client";
import {
  DEFAULT_DESIGNER_SETTINGS,
  DESIGNER_SETTINGS_ASSET_KIND,
  DESIGNER_SETTINGS_ASSET_NAME,
  DESIGNER_SETTINGS_PATH,
  mergeDesignerSettings,
  parseDesignerSettings,
  type DesignerSettings,
} from "@solutions-builder/app/designer-settings";
import { assetsFor, readWorkflowSourceBlob, writeWorkflowSourceTree } from "./hub.js";

async function designerSettingsAssetId(transport: Transport, tenantId: string): Promise<string | null> {
  const found = (await assetsFor(transport, tenantId).list(DESIGNER_SETTINGS_ASSET_KIND)).find(
    (asset) => asset.name === DESIGNER_SETTINGS_ASSET_NAME,
  );
  return found?.id ?? null;
}

/** The settings as saved on the tenant, with defaults for anything missing or unreadable. */
export async function readDesignerSettings(transport: Transport, tenantId: string): Promise<DesignerSettings> {
  const assetId = await designerSettingsAssetId(transport, tenantId);
  if (!assetId) return DEFAULT_DESIGNER_SETTINGS;
  const raw = await readWorkflowSourceBlob(transport, tenantId, assetId, DESIGNER_SETTINGS_PATH);
  return raw === null ? DEFAULT_DESIGNER_SETTINGS : parseDesignerSettings(JSON.parse(raw));
}

/** Saves a change to one or more settings onto the tenant's asset, refusing a value the type rejects. */
export async function saveDesignerSettings(
  transport: Transport,
  tenantId: string,
  patch: Partial<DesignerSettings>,
): Promise<DesignerSettings> {
  const assets = assetsFor(transport, tenantId);
  let assetId = await designerSettingsAssetId(transport, tenantId);
  const current = assetId
    ? parseDesignerSettings(
        JSON.parse((await readWorkflowSourceBlob(transport, tenantId, assetId, DESIGNER_SETTINGS_PATH)) ?? "{}"),
      )
    : DEFAULT_DESIGNER_SETTINGS;
  const next = mergeDesignerSettings(current, patch);
  if (!assetId) {
    assetId = (
      await assets.create({
        kind: DESIGNER_SETTINGS_ASSET_KIND,
        name: DESIGNER_SETTINGS_ASSET_NAME,
        displayName: "Designer settings",
      })
    ).id;
  }
  await writeWorkflowSourceTree(transport, tenantId, {
    assetId,
    files: { [DESIGNER_SETTINGS_PATH]: `${JSON.stringify(next, null, 2)}\n` },
    message: "Update designer settings",
  });
  return next;
}
