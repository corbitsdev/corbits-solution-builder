/**
 * UPSTREAM_GAP routes the installer package calls in place of the direct
 * platform writes `hub-gaps.ts` still makes. Each one is that file's own
 * numbered gap, given a route: not a new design, a name for the ask CL-8075
 * closes once upstream fills it. Nothing here does anything `hub-gaps.ts`
 * did not already do; `installer-bridge.ts`'s `InstallerGaps` implementation
 * calls these functions directly in-process (the installer runs inside this
 * host, not out of it), so this file is the honest, greppable surface for
 * the gap rather than the runtime path — a client that ever ran the
 * installer out-of-process would call these instead.
 */
import type { Hono } from "hono";
import { canPlaceSidecars, hub } from "./hub-mount.js";
import {
  adoptLegacyWorkspace,
  allocationBinding,
  listChildTenants,
  readWorkflowSourceBlob,
  registerDefinition,
  writeWorkflowSourceTree,
} from "./hub-gaps.js";

export function registerInstallerGapRoutes(api: Hono) {
  // UPSTREAM_GAP 1: registerDefinition.
  api.post("/tenants/:tenantId/installer-gaps/definitions", async (context) => {
    const tenantId = context.req.param("tenantId");
    const row = await context.req.json();
    return context.json(await registerDefinition(tenantId, row));
  });

  // UPSTREAM_GAP 4: adoptLegacyWorkspace.
  api.post("/installer-gaps/adopt-legacy-workspace", async (context) => {
    const { userId } = (await context.req.json()) as { userId: string };
    return context.json({ adopted: await adoptLegacyWorkspace(userId) });
  });

  // UPSTREAM_GAP 10: listChildTenants.
  api.get("/tenants/:tenantId/installer-gaps/children", async (context) => {
    const tenantId = context.req.param("tenantId");
    return context.json({ tenants: await listChildTenants(tenantId) });
  });

  // No JSON "write tree" route on an asset.
  api.post("/tenants/:tenantId/installer-gaps/assets/:assetId/source-tree", async (context) => {
    const assetId = context.req.param("assetId");
    const body = (await context.req.json()) as { files: Record<string, string>; message: string };
    return context.json(await writeWorkflowSourceTree({ assetId, files: body.files, message: body.message }));
  });

  api.get("/tenants/:tenantId/installer-gaps/assets/:assetId/source-blob", async (context) => {
    const assetId = context.req.param("assetId");
    const path = context.req.query("path") ?? "";
    return context.json({ content: await readWorkflowSourceBlob(assetId, path) });
  });

  // UPSTREAM_GAP 11: allocationBinding.
  api.get("/tenants/:tenantId/installer-gaps/deployments/:anchorRunId/binding", async (context) => {
    const anchorRunId = context.req.param("anchorRunId");
    return context.json({ binding: await allocationBinding(anchorRunId) });
  });

  // Whether this host process can place a sidecar, and its own binding
  // fingerprint: mount-internal, not a platform write, but the same reason —
  // only `hub-mount.ts` sees them — puts them beside the gap routes.
  api.get("/installer-gaps/sidecar-capability", (context) =>
    context.json({ canPlaceSidecars: canPlaceSidecars(), fingerprint: hub().sidecarBindingFingerprint }),
  );
}
