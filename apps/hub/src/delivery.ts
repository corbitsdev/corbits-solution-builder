/**
 * Delivery verification — the bytes behind a manifest are checked, not
 * trusted. Each check is recorded as an artifact version of kind
 * `delivery_verification` whose source is the manifest version it checked, so
 * "what was verified, against what, when" is a version like every other
 * record here.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  DeliveryManifest,
  describeBlockers,
  summarizeVerification,
  type DeliveryDescriptor,
  type VerificationItem,
  type VerificationReport,
} from "@solutions-builder/app/delivery";
import { type } from "arktype";
import { database } from "./db.js";
import * as table from "./schema.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { workspaceFor } from "./corbits-exec.js";

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return { sha256: hash.digest("hex"), sizeBytes: info.size };
}

/** Keeps a descriptor's path inside the workspace it claims to describe. */
function containedPath(root: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const resolved = normalize(join(root, relative));
  return resolved.startsWith(normalize(root) + "/") ? resolved : null;
}

async function checkDescriptor(descriptor: DeliveryDescriptor, workspaceRoot: string): Promise<VerificationItem> {
  const base = { category: descriptor.category, path: descriptor.path, required: descriptor.required };
  // No remote fetcher exists in this host. A remote descriptor is unverified
  // until one does; a local file of the same name proves nothing about it.
  if (descriptor.access === "remote") {
    return { ...base, status: "inaccessible", detail: "no remote fetcher is configured on this host" };
  }
  const path = containedPath(workspaceRoot, descriptor.path);
  if (!path) return { ...base, status: "inaccessible", detail: "the path leaves the build workspace" };
  try {
    const actual = await hashFile(path);
    if (actual.sha256 !== descriptor.sha256 || actual.sizeBytes !== descriptor.sizeBytes) {
      return {
        ...base,
        status: "hash_mismatch",
        detail: `expected ${descriptor.sha256.slice(0, 12)} (${descriptor.sizeBytes} bytes), found ${actual.sha256.slice(0, 12)} (${actual.sizeBytes} bytes)`,
      };
    }
    return { ...base, status: "verified" };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ...base, status: "missing" };
    return { ...base, status: "inaccessible", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Checks every descriptor against the bytes under `workspaceRoot`. */
export async function verifyManifest(
  manifestNodeId: string,
  manifest: DeliveryManifest,
  workspaceRoot: string,
): Promise<VerificationReport> {
  const items: VerificationItem[] = [];
  for (const descriptor of manifest.descriptors) items.push(await checkDescriptor(descriptor, workspaceRoot));
  return summarizeVerification(manifestNodeId, items, new Date());
}

export type ManifestVersion = {
  node: typeof table.artifactNode.$inferSelect;
  manifest: DeliveryManifest;
};

/** The newest delivery manifest on a project, parsed, or null before stage 9. */
export async function latestManifest(projectId: string): Promise<ManifestVersion | null> {
  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(and(eq(table.artifactNode.projectId, projectId), eq(table.artifactNode.kind, "delivery_manifest")))
    .orderBy(desc(table.artifactNode.createdAt))
    .limit(1);
  if (!node) return null;
  const { content } = await readArtifactNode(node.id);
  const parsed = DeliveryManifest(JSON.parse(content));
  if (parsed instanceof type.errors) {
    throw new Error(`Delivery manifest ${node.id} does not parse: ${parsed.summary}`);
  }
  return { node, manifest: parsed };
}

/** The newest verification recorded for a manifest version, or null. */
export async function latestVerification(manifestNodeId: string): Promise<VerificationReport | null> {
  const { db } = database();
  const rows = await db
    .select({ childNodeId: table.artifactEdge.childNodeId })
    .from(table.artifactEdge)
    .where(eq(table.artifactEdge.sourceNodeId, manifestNodeId));
  let newest: { report: VerificationReport; createdAt: Date } | null = null;
  for (const row of rows) {
    const { node, content } = await readArtifactNode(row.childNodeId);
    if (node.kind !== "delivery_verification") continue;
    if (newest && newest.createdAt > node.createdAt) continue;
    newest = { report: JSON.parse(content) as VerificationReport, createdAt: node.createdAt };
  }
  return newest?.report ?? null;
}

/**
 * Verifies the manifest's bytes in the build workspace that produced it and
 * records the report as a version sourced from the manifest.
 */
export async function verifyAndRecord(
  projectId: string,
  version: ManifestVersion,
  actor: { principalId: string },
): Promise<VerificationReport> {
  // The manifest's producer run is the build run whose workspace holds the bytes.
  const buildRunId = version.node.producerRunId ?? "";
  const workspaceRoot = await workspaceFor(buildRunId);
  const report = await verifyManifest(version.node.id, version.manifest, workspaceRoot);
  await writeArtifact(
    {
      projectId,
      kind: "delivery_verification",
      title: report.complete ? "Delivery verified" : "Delivery verification failed",
      content: JSON.stringify(report, null, 2),
      mediaType: "application/json",
      sourceVersionIds: [version.node.id],
      provenance: { producer: "human", ...(buildRunId ? { runId: buildRunId } : {}) },
    },
    actor,
  );
  return report;
}

/** What blocks acceptance of the project's latest manifest, or null when nothing does. */
export async function deliveryBlockers(projectId: string): Promise<string | null> {
  const version = await latestManifest(projectId);
  if (!version) return null;
  const report = await latestVerification(version.node.id);
  if (!report) return "Delivery cannot be accepted yet. The manifest has not been verified.";
  return describeBlockers(report);
}
