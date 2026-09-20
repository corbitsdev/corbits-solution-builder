/**
 * Stage 9's opening mail (CL-8723 follow-up).
 *
 * The delivery-verifier has no filesystem and no view of stage 8's working
 * directory (`kit.ts`'s stage-9 prompt): everything it can check comes from
 * plain text in its opening message. `publish_workspace`
 * (`@solutions-builder/tools-delivery`) uploads a companion delivery
 * manifest artifact alongside the build archive — this module turns that
 * manifest's content, once read back, into the exact text the prompt
 * promises: the manifest node id, the archive's file name/size/sha256, the
 * capped file list with hashes, and the checks stage 8 declared (its own
 * chat reply). Deliberately NOT importing `@solutions-builder/tools-delivery`
 * here — this type mirrors `publish-workspace.ts`'s `DeliveryManifestContent`
 * rather than importing it, so the web bundle never pulls in a sidecar tool
 * package's `node:child_process`/`node:fs` runtime code.
 */

export type DeliveryManifestFile = { path: string; sha256: string; sizeBytes: number };

export type DeliveryManifestContent = {
  projectId: string;
  stage: 8;
  attempt: string;
  archive: { fileName: string; sizeBytes: number; sha256: string };
  files: DeliveryManifestFile[];
  fileCount: number;
  truncated: boolean;
  generatedAt: string;
};

/** Parses a manifest artifact's raw content, or null if it does not look
 *  like one — never throws, so a malformed or missing manifest degrades to
 *  the "no manifest" opening rather than blocking stage 9 from opening at all. */
export function parseDeliveryManifest(content: string): DeliveryManifestContent | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const archive = parsed["archive"] as Record<string, unknown> | undefined;
    if (
      typeof parsed["projectId"] !== "string" ||
      !Array.isArray(parsed["files"]) ||
      !archive ||
      typeof archive["fileName"] !== "string" ||
      typeof archive["sha256"] !== "string"
    ) {
      return null;
    }
    return parsed as unknown as DeliveryManifestContent;
  } catch {
    return null;
  }
}

/**
 * Stage 9's opening mail body: the manifest node id (id@version), the
 * archive's identity, the capped file list with hashes, and the checks
 * stage 8 declared (its own reply text, verbatim). When no manifest is
 * available (the fallback data-URI path was used, or none could be read),
 * says so plainly rather than inventing one — the verifier's prompt already
 * treats an unhanded check as `"inaccessible"`, never a pass.
 */
export function deliveryOpeningLine(
  manifest: { readonly artifactId: string; readonly version: number; readonly content: DeliveryManifestContent } | null,
  buildStatusBody: string,
): string {
  if (!manifest) {
    return [
      "No delivery manifest artifact is available for this build — stage 8 either used the data-URI fallback (no artifact-upload credential was bound) or no manifest could be read.",
      'Score every check you cannot confirm yourself as "inaccessible", never a pass.',
      "",
      "Checks stage 8 declared:",
      buildStatusBody,
    ].join("\n");
  }
  const { content } = manifest;
  const lines: string[] = [
    `Manifest node id: ${manifest.artifactId}@${String(manifest.version)}`,
    `Archive: ${content.archive.fileName} — ${String(content.archive.sizeBytes)} bytes — sha256 ${content.archive.sha256}`,
    "",
    `Files (${String(content.files.length)} of ${String(content.fileCount)} total${
      content.truncated ? ", capped at 200 — anything past this list is unverifiable from this text, score it \"inaccessible\", not a pass" : ""
    }):`,
  ];
  for (const file of content.files) {
    lines.push(`- ${file.path} — ${String(file.sizeBytes)} bytes — sha256 ${file.sha256}`);
  }
  lines.push("", "Checks stage 8 declared:", buildStatusBody);
  return lines.join("\n");
}
