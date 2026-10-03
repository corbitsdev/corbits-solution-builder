/**
 * Stage 9's opening mail (CL-8723 follow-up).
 *
 * The delivery-verifier has no filesystem and no view of stage 8's working
 * directory (`kit.ts`'s stage-9 prompt): everything it can check comes from
 * plain text in its opening message. The host's packaging of a build
 * attempt (`@solutions-builder/specialist-runtime/package-attempt`, run by
 * the build route) produces a delivery manifest beside the build archive,
 * which the client records with it — this module turns that manifest's
 * content, once read back, into the exact text the prompt promises: the
 * manifest node id, the archive's file name/size/sha256, the capped file
 * list with hashes, and the checks stage 8 declared (the supervisor's own
 * status reply). Deliberately NOT importing the runtime package here — this
 * type mirrors `package-attempt.ts`'s `DeliveryManifestContent` rather than
 * importing it, so the web bundle never pulls in `node:child_process`/
 * `node:fs` runtime code.
 */

// The person reads local time beside these texts; a specialist must quote the same moment.
export function zonedTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { timeZoneName: "short" });
}

export type DeliveryManifestFile = { path: string; sha256: string; sizeBytes: number };

/** What the packaging's checks established about the archive itself (#129):
 *  mirrors `specialist-runtime/src/verify.ts`'s `DeliveryVerificationContent`. */
export type DeliveryVerificationContent = {
  checkedAt: string;
  checkedBy: "tool";
  /** Where the targets were started: the sidecar, or the host; absent on an older manifest. */
  ranOn?: "sidecar" | "host";
  archiveExtras: number;
  items: { category: string; path: string; required: boolean; status: string; checkedBy?: string; detail?: string }[];
  targets: { target: string; modality: string; exercised: boolean; ranSuccessfully: boolean; transcript: string }[];
  /** The quality bar's scan; absent on a manifest written before it. */
  quality?: { scannedFiles: number; skippedFiles: number };
  report: { complete: boolean; failed: string[] };
};

export type DeliveryManifestContent = {
  stage: 8;
  attempt: string;
  archive: { fileName: string; sizeBytes: number; sha256: string };
  files: DeliveryManifestFile[];
  fileCount: number;
  truncated: boolean;
  generatedAt: string;
  verification?: DeliveryVerificationContent;
};

/** The verification as the verifier reads it: every item the tool checked
 *  with its status, and each target's transcript. Never summarised into a
 *  pass; a failed or missing item is listed as such. */
export function verificationLines(verification: DeliveryVerificationContent | undefined): string[] {
  if (!verification || verification.checkedBy !== "tool") {
    return ["Verification recorded with the archive: none. Nothing about this archive was checked by a tool; treat every check as not run."];
  }
  const verified = verification.items.filter((item) => item.status === "verified").length;
  const lines = [
    `Verification recorded with the archive at ${zonedTime(verification.checkedAt)} (checked by the tool, not by a model): ${String(verified)} of ${String(verification.items.length)} checks verified; ${
      verification.report.complete ? "no required item failed" : `required items not verified: ${verification.report.failed.join(", ")}`
    }.`,
  ];
  for (const item of verification.items) {
    lines.push(`- ${item.path}: ${item.status}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  lines.push(
    verification.quality
      ? `- Quality bar: ${String(verification.quality.scannedFiles)} file(s) scanned for stub markers, placeholder content and dropped errors, each finding listed above at its path and line; ${String(verification.quality.skippedFiles)} binary, oversized or lock file(s) not read.`
      : "- Quality bar: not scanned when this archive was recorded; no stub, placeholder or error-handling check ran.",
  );
  if (verification.archiveExtras > 0) {
    lines.push(`- ${String(verification.archiveExtras)} file(s) in the archive are not listed in the manifest and were not checked.`);
  }
  if (verification.targets.length === 0) {
    lines.push("- No web or api target was started or probed.");
  }
  for (const target of verification.targets) {
    const where = verification.ranOn === "host" ? " on the host, with the command in its transcript" : "";
    lines.push("", `Target "${target.target}" (${target.modality}) ${target.exercised ? (target.ranSuccessfully ? `ran${where} and answered` : `was started${where} and did not pass`) : "was not exercised"}:`, target.transcript);
  }
  return lines;
}

/** Parses a manifest artifact's raw content, or null if it does not look
 *  like one — never throws, so a malformed or missing manifest degrades to
 *  the "no manifest" opening rather than blocking stage 9 from opening at all. */
export function parseDeliveryManifest(content: string): DeliveryManifestContent | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const archive = parsed["archive"] as Record<string, unknown> | undefined;
    // No project id is checked for: a manifest written since #41 step 5
    // carries none (the project is the tenant it lives in), and one written
    // before still parses.
    if (
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
      "No delivery manifest artifact is available for this build — the Build and test archive was recorded without one, or no manifest could be read.",
      "No check was run by a tool, so nothing about this archive is verified; say so, never score a pass.",
      "",
      "Checks Build and test declared:",
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
  lines.push("", ...verificationLines(content.verification));
  lines.push("", "Checks Build and test declared:", buildStatusBody);
  return lines.join("\n");
}
