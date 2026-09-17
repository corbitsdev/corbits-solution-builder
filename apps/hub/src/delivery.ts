/**
 * Delivery verification — the bytes behind a manifest are checked, not
 * trusted. Each check is recorded as an artifact version of kind
 * `delivery_verification` whose source is the manifest version it checked, so
 * "what was verified, against what, when" is a version like every other
 * record here.
 *
 * Existence checks (below) only prove a descriptor's bytes are present; they
 * cannot tell working software from a scaffold of stubs. `runExecutionChecks`
 * (in `execution-checks.ts`, shared with the build loop in `corbits-exec.ts`)
 * closes that gap by actually running the deliverable's entry point, and its
 * declared tests and typecheck, inside the workspace.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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
import { HostError } from "./errors.js";
import * as table from "./schema.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { workspaceFor } from "./corbits-exec.js";
import { containedPath, runExecutionChecks, hasWorkingDeliverable, type ExecutionCheck } from "./execution-checks.js";

export type { ExecutionCheck, ExecutionKind } from "./execution-checks.js";

/** A `VerificationReport` plus what actually ran, so "present" and "works" are distinct. */
export type DeliveryVerificationReport = VerificationReport & {
  readonly execution: ExecutionCheck[];
};

async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return { sha256: hash.digest("hex"), sizeBytes: info.size };
}

/** Keeps a descriptor's path inside the workspace it claims to describe. */
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

/**
 * Checks every descriptor against the bytes under `workspaceRoot`, then runs
 * the deliverable to see whether it does anything. A required descriptor
 * that is merely present no longer reads as "verified" on its own — an
 * execution check that fails is exactly as blocking.
 */
export async function verifyManifest(
  manifestNodeId: string,
  manifest: DeliveryManifest,
  workspaceRoot: string,
): Promise<DeliveryVerificationReport> {
  const items: VerificationItem[] = [];
  for (const descriptor of manifest.descriptors) items.push(await checkDescriptor(descriptor, workspaceRoot));
  const base = summarizeVerification(manifestNodeId, items, new Date());
  const execution = await runExecutionChecks(workspaceRoot);
  const executionFailures = execution.filter((check) => !check.ok).map((check) => `execution:${check.kind}`);
  // Every check can pass while none of them prove anything was built — the
  // same blind spot the build loop closes with `hasWorkingDeliverable`.
  // Only asserted when there is at least one check to have proven anything
  // with: an empty `execution` (nothing runnable was discoverable) is left
  // to the existence checks above, as it always has been.
  if (execution.length > 0 && executionFailures.length === 0 && !hasWorkingDeliverable(execution)) {
    executionFailures.push("execution:no_evidence");
  }
  return {
    ...base,
    complete: base.complete && executionFailures.length === 0,
    failed: [...base.failed, ...executionFailures],
    execution,
  };
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
export async function latestVerification(manifestNodeId: string): Promise<DeliveryVerificationReport | null> {
  const { db } = database();
  const rows = await db
    .select({ childNodeId: table.artifactEdge.childNodeId })
    .from(table.artifactEdge)
    .where(eq(table.artifactEdge.sourceNodeId, manifestNodeId));
  let newest: { report: DeliveryVerificationReport; createdAt: Date } | null = null;
  for (const row of rows) {
    const { node, content } = await readArtifactNode(row.childNodeId);
    if (node.kind !== "delivery_verification") continue;
    if (newest && newest.createdAt > node.createdAt) continue;
    newest = { report: JSON.parse(content) as DeliveryVerificationReport, createdAt: node.createdAt };
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
): Promise<DeliveryVerificationReport> {
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

/** One sentence naming what execution checks failed, or null when all passed. */
function describeExecutionFailures(execution: ExecutionCheck[]): string | null {
  const failed = execution.filter((check) => !check.ok);
  if (failed.length > 0) {
    return `execution failed: ${failed.map((check) => `${check.kind} (${check.detail})`).join("; ")}`;
  }
  if (execution.length > 0 && !hasWorkingDeliverable(execution)) {
    return "execution checks all passed, but none of them are evidence a deliverable exists (no entry point, no real tests, no real typecheck)";
  }
  return null;
}

/** What blocks acceptance of the project's latest manifest, or null when nothing does. */
export async function deliveryBlockers(projectId: string): Promise<string | null> {
  const version = await latestManifest(projectId);
  if (!version) return null;
  const report = await latestVerification(version.node.id);
  if (!report) return "Delivery cannot be accepted yet. The manifest has not been verified.";
  const existence = describeBlockers(report);
  const execution = describeExecutionFailures(report.execution);
  if (!existence && !execution) return null;
  if (existence && execution) return `${existence} ${execution}.`;
  return existence ?? `Delivery cannot be accepted yet. ${execution}.`;
}

/**
 * Re-runs verification against the latest manifest and records the new
 * report — the retry path out of a blocked delivery verdict. Only
 * execution-layer staleness is re-checkable this way (a flaked run, or a
 * probe that has since learned to recognise the deliverable): the manifest's
 * recorded hashes do not move, so bytes that changed since it was recorded
 * still mismatch, and that failure names recording a new delivery as the
 * next move. A manifest whose latest verification already passes is returned
 * as-is — re-running a green check would only burn time and stack another
 * identical artifact.
 */
export async function reverifyDelivery(
  projectId: string,
  actor: { principalId: string },
): Promise<DeliveryVerificationReport> {
  const version = await latestManifest(projectId);
  if (!version) throw new HostError("not_found", "There is no delivery manifest to verify again.");
  const latest = await latestVerification(version.node.id);
  if (latest?.complete) return latest;
  const report = await verifyAndRecord(projectId, version, actor);
  const existence = describeBlockers(report);
  if (existence) {
    throw new HostError(
      "conflict",
      `${existence} The bytes changed without recording a new manifest — record the delivery again first, then verify. Re-running against this manifest cannot pass.`,
    );
  }
  return report;
}
