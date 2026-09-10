/**
 * Delivery evidence — BUILD_PLAN_V3 Gate 6.
 *
 * A delivery manifest names every byte the recipient is owed: source, assets,
 * docs, tests and receipts, each with the exact hash and size the build
 * produced. A verification report is what a host actually checked against
 * those descriptors. Neither is a claim: a descriptor the host could not
 * reach is `inaccessible`, never assumed present, and a local path is never
 * evidence that anything remote exists.
 */
import { type } from "arktype";

export const DESCRIPTOR_CATEGORIES = ["source", "assets", "docs", "tests", "receipts"] as const;
export type DescriptorCategory = (typeof DESCRIPTOR_CATEGORIES)[number];

export const DeliveryDescriptor = type({
  category: type.enumerated(...DESCRIPTOR_CATEGORIES),
  /** Relative to the build workspace for `local`; an opaque locator for `remote`. */
  path: "string > 0",
  sha256: /^[0-9a-f]{64}$/,
  sizeBytes: "number >= 0",
  mediaType: "string > 0",
  access: "'local' | 'remote'",
  /** A required descriptor that fails verification blocks stage 9. */
  required: "boolean",
});
export type DeliveryDescriptor = typeof DeliveryDescriptor.infer;

export const DeliveryManifest = type({
  descriptors: DeliveryDescriptor.array(),
  /** The stage 7 forecast, carried so the actual sits beside it. */
  costForecast: "number | null",
  costActual: "number | null",
  /** Why `costActual` is null when it is; never a number invented to fill it. */
  costActualReason: "string | null",
  "verification?": "unknown",
  "exceptions?": "unknown",
});
export type DeliveryManifest = typeof DeliveryManifest.infer;

export const VERIFICATION_STATUSES = ["verified", "missing", "hash_mismatch", "inaccessible"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VerificationItem = type({
  category: type.enumerated(...DESCRIPTOR_CATEGORIES),
  path: "string > 0",
  required: "boolean",
  status: type.enumerated(...VERIFICATION_STATUSES),
  "detail?": "string",
});
export type VerificationItem = typeof VerificationItem.infer;

export const VerificationReport = type({
  /** The manifest version these checks ran against. */
  manifestNodeId: "string > 0",
  checkedAt: "string > 0",
  /** True only when every required descriptor is `verified`. */
  complete: "boolean",
  items: VerificationItem.array(),
  /** Paths of required descriptors that are not `verified`. */
  failed: "string[]",
});
export type VerificationReport = typeof VerificationReport.infer;

/**
 * Accepts what a worker actually sends today — `{ name, sha256, sizeBytes }`
 * from the bounded bridge — and fills the fields the manifest requires with
 * the honest defaults: local, required, source, unknown media type.
 */
export function normalizeDescriptor(raw: unknown): DeliveryDescriptor | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : typeof record.name === "string" ? record.name : "";
  const candidate = {
    category: record.category ?? "source",
    path,
    sha256: String(record.sha256 ?? "").toLowerCase(),
    sizeBytes: Number(record.sizeBytes ?? -1),
    mediaType: record.mediaType ?? "application/octet-stream",
    access: record.access ?? "local",
    required: record.required ?? true,
  };
  const parsed = DeliveryDescriptor(candidate);
  return parsed instanceof type.errors ? null : parsed;
}

/** A report is complete when nothing the recipient is owed is unverified. */
export function summarizeVerification(
  manifestNodeId: string,
  items: VerificationItem[],
  checkedAt: Date,
): VerificationReport {
  const failed = items.filter((item) => item.required && item.status !== "verified").map((item) => item.path);
  return { manifestNodeId, checkedAt: checkedAt.toISOString(), complete: failed.length === 0, items, failed };
}

/** One sentence naming what blocks acceptance, for the decision queue. */
export function describeBlockers(report: VerificationReport): string | null {
  if (report.complete) return null;
  const byStatus = new Map<VerificationStatus, string[]>();
  for (const item of report.items) {
    if (!item.required || item.status === "verified") continue;
    byStatus.set(item.status, [...(byStatus.get(item.status) ?? []), item.path]);
  }
  const parts = [...byStatus.entries()].map(([status, paths]) => `${status.replace("_", " ")}: ${paths.join(", ")}`);
  return `Delivery cannot be accepted yet. ${parts.join("; ")}.`;
}
