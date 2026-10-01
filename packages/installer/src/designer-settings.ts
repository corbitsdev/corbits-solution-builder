/**
 * The designer's settings, read and written under their own key in the
 * workspace tenant's `config` -- the stock per-tenant JSON every Interchange
 * hub serves through `GET`/`PATCH /api/tenants/:id` -- the way
 * `project-tenant.ts` keeps the project record. No asset, no kind the hub
 * has to know about (#358).
 */
import type { Transport } from "@intx/hub-client";
import {
  DESIGNER_SETTINGS_CONFIG_KEY,
  mergeDesignerSettings,
  parseDesignerSettings,
  type DesignerSettings,
} from "@solutions-builder/app/designer-settings";
import { getTenant, patchTenant, type HubTenant } from "./hub.js";

function settingsOf(tenant: HubTenant | null): DesignerSettings {
  return parseDesignerSettings(tenant?.config?.[DESIGNER_SETTINGS_CONFIG_KEY]);
}

/** The settings as saved on the tenant, with defaults for anything missing or unreadable. */
export async function readDesignerSettings(transport: Transport, tenantId: string): Promise<DesignerSettings> {
  return settingsOf(await getTenant(transport, tenantId));
}

/** Saves a change to one or more settings onto the tenant's config, refusing a value the type rejects. */
export async function saveDesignerSettings(
  transport: Transport,
  tenantId: string,
  patch: Partial<DesignerSettings>,
): Promise<DesignerSettings> {
  const tenant = await getTenant(transport, tenantId);
  if (!tenant) throw new Error("The workspace tenant was not found.");
  const next = mergeDesignerSettings(settingsOf(tenant), patch);
  await patchTenant(transport, tenantId, {
    config: { ...(tenant.config ?? {}), [DESIGNER_SETTINGS_CONFIG_KEY]: next },
  });
  return next;
}
