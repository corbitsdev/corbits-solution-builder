/**
 * The workspace's language settings (#411), read and written under their
 * own key in the workspace tenant's `config`, exactly as the designer
 * settings are (`designer-settings.ts`).
 */
import type { Transport } from "@intx/hub-client";
import {
  LANGUAGE_SETTINGS_CONFIG_KEY,
  mergeLanguageSettings,
  parseLanguageSettings,
  type LanguageSettings,
} from "@solutions-builder/app/language-settings";
import { getTenant, patchTenant, type HubTenant } from "./hub.js";

function settingsOf(tenant: HubTenant | null): LanguageSettings {
  return parseLanguageSettings(tenant?.config?.[LANGUAGE_SETTINGS_CONFIG_KEY]);
}

/** The settings as saved on the tenant, with defaults for anything missing or unreadable. */
export async function readLanguageSettings(transport: Transport, tenantId: string): Promise<LanguageSettings> {
  return settingsOf(await getTenant(transport, tenantId));
}

/** Saves a change onto the tenant's config, refusing a value the type rejects or an output not yet supported. */
export async function saveLanguageSettings(transport: Transport, tenantId: string, patch: Partial<LanguageSettings>): Promise<LanguageSettings> {
  const tenant = await getTenant(transport, tenantId);
  if (!tenant) throw new Error("The workspace tenant was not found.");
  const next = mergeLanguageSettings(settingsOf(tenant), patch);
  await patchTenant(transport, tenantId, { config: { ...(tenant.config ?? {}), [LANGUAGE_SETTINGS_CONFIG_KEY]: next } });
  return next;
}
