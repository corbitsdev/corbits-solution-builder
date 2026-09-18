/**
 * Asset reads for a client that only has a `Transport`.
 *
 * `./hub.ts` already carries `assetsFor` (list-by-kind, create, writeTree) and
 * `readWorkflowSourceBlob` for the installer's own workflow-source use; this
 * module re-exports those and adds the two reads that use needs but the
 * installer's own call sites never did: a listing that is not scoped to one
 * `kind` (`GET /assets` with no `kind` query, matching
 * `vendor/interchange/packages/hub-api/src/routes/assets.ts`'s "List assets"
 * route), and a blob read decoded as JSON rather than text. It does not touch
 * `./hub.ts` -- another lane owns edits there.
 */
import { ApiError, type Transport } from "@intx/hub-client";

export { assetsFor, readWorkflowSourceBlob, writeWorkflowSourceTree, type HubAsset } from "./hub.js";

export type HubAssetWithOrigin = {
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  origin: { tenantId: string; direct: boolean };
};

/**
 * Every asset visible on `scope`: with `inherited` left at its default
 * (`true`), this walks up the tenant hierarchy the way the route itself
 * does, tagging each row with the tenant that supplied it.
 */
export async function listAssets(
  transport: Transport,
  scope: string,
  opts?: { kind?: string; inherited?: boolean },
): Promise<HubAssetWithOrigin[]> {
  const query = new URLSearchParams();
  if (opts?.kind !== undefined) query.set("kind", opts.kind);
  if (opts?.inherited !== undefined) query.set("inherited", String(opts.inherited));
  const search = query.toString();
  return transport.fetch<HubAssetWithOrigin[]>(
    "GET",
    `/api/tenants/${scope}/assets${search ? `?${search}` : ""}`,
  );
}

/**
 * The bytes at `path` on an asset's ref, parsed as JSON, or `null` when the
 * asset, ref or path is absent, or the bytes are not valid JSON for `T`. Same
 * envelope as `readWorkflowSourceBlob` (base64 JSON, decoded once at this
 * boundary); this is the JSON sibling for callers reading a manifest or
 * config file off an asset rather than source text.
 */
export async function readAssetJson<T>(
  transport: Transport,
  scope: string,
  assetId: string,
  path: string,
  ref?: string,
): Promise<T | null> {
  try {
    const query = new URLSearchParams({ path });
    if (ref !== undefined) query.set("ref", ref);
    const { content } = await transport.fetch<{ content: string }>(
      "GET",
      `/api/tenants/${scope}/assets/${assetId}/blob?${query.toString()}`,
    );
    const bytes = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }
}
