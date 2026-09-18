/**
 * The designer's settings, read and saved through the workspace-tenant asset
 * the installer package writes — not host preferences.
 */
import { DEFAULT_DESIGNER_SETTINGS, type DesignerSettings } from "@solutions-builder/app/designer-settings";
import {
  readDesignerSettings,
  resolveWorkspace,
  saveDesignerSettings as installerSaveDesignerSettings,
} from "@solutions-builder/installer";
import type { Transport } from "./hub.ts";

export type { DesignerSettings } from "@solutions-builder/app/designer-settings";

/** The settings on the workspace tenant, defaulted before a tenant exists. */
export async function designerSettings(transport: Transport): Promise<DesignerSettings> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return DEFAULT_DESIGNER_SETTINGS;
  return readDesignerSettings(transport, workspace.tenantId);
}

export async function saveDesignerSettings(
  transport: Transport,
  patch: Partial<DesignerSettings>,
): Promise<DesignerSettings> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("The workspace is not installed yet.");
  return installerSaveDesignerSettings(transport, workspace.tenantId, patch);
}
