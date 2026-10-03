import { describe, expect, test } from "bun:test";
import { deliveryOpeningLine, parseDeliveryManifest, verificationLines, type DeliveryManifestContent } from "./delivery-opening.ts";

const manifest = (verification?: DeliveryManifestContent["verification"]): DeliveryManifestContent => ({
  stage: 8,
  attempt: "attempt-1",
  archive: { fileName: "proj-attempt-1.tar.gz", sizeBytes: 10, sha256: "a".repeat(64) },
  files: [{ path: "src/index.ts", sha256: "b".repeat(64), sizeBytes: 5 }],
  fileCount: 1,
  truncated: false,
  generatedAt: "2026-01-01T00:00:00.000Z",
  ...(verification ? { verification } : {}),
});

describe("verificationLines", () => {
  test("a manifest with no tool verification says nothing was checked", () => {
    expect(verificationLines(undefined)[0]).toContain("Nothing about this archive was checked by a tool");
  });

  test("quotes each tool-checked item and each target's transcript, failures included", () => {
    const lines = verificationLines({
      checkedAt: "2026-01-01T00:01:00.000Z",
      checkedBy: "tool",
      archiveExtras: 2,
      items: [
        { category: "source", path: "src/index.ts", required: true, status: "verified", checkedBy: "tool" },
        { category: "receipts", path: "target:web", required: true, status: "failed", checkedBy: "tool", detail: "port 3000 never accepted a connection" },
      ],
      targets: [{ target: "web", modality: "web", exercised: true, ranSuccessfully: false, transcript: "$ bun run start\n\nport 3000 never accepted a connection within 15000ms." }],
      report: { complete: false, failed: ["target:web"] },
    });
    expect(lines[0]).toContain("checked by the tool, not by a model");
    expect(lines[0]).toContain("required items not verified: target:web");
    expect(lines).toContain("- src/index.ts: verified");
    expect(lines).toContain("- target:web: failed — port 3000 never accepted a connection");
    expect(lines.some((line) => line.includes("2 file(s) in the archive are not listed"))).toBe(true);
    expect(lines).toContain('Target "web" (web) was started and did not pass:');
    expect(lines.at(-1)).toContain("never accepted a connection within 15000ms");
  });

  test("a verification not marked as the tool's is not quoted as one", () => {
    expect(verificationLines({ checkedBy: "agent" } as never)[0]).toContain("Nothing about this archive was checked by a tool");
  });
});

describe("deliveryOpeningLine", () => {
  test("carries the manifest, then the tool's verification, then stage 8's own words", () => {
    const body = deliveryOpeningLine(
      { artifactId: "art_m", version: 2, content: manifest({ checkedAt: "2026-01-01T00:01:00.000Z", checkedBy: "tool", archiveExtras: 0, items: [], targets: [], report: { complete: true, failed: [] } }) },
      "## Commands run and output\nbun test",
    );
    const at = (needle: string) => body.indexOf(needle);
    expect(at("Manifest node id: art_m@2")).toBe(0);
    expect(at("- src/index.ts — 5 bytes")).toBeGreaterThan(0);
    expect(at("Verification recorded with the archive")).toBeGreaterThan(at("- src/index.ts — 5 bytes"));
    expect(at("No web or api target was started or probed.")).toBeGreaterThan(0);
    expect(at("What the build supervisor reported:")).toBeGreaterThan(at("Verification recorded with the archive"));
    expect(body.endsWith("bun test")).toBe(true);
  });

  test("with no manifest, says no check was run and never asks for a pass", () => {
    const body = deliveryOpeningLine(null, "status");
    expect(body).toContain("No check was run by a tool");
    expect(body).not.toContain("inaccessible");
  });

  test("parseDeliveryManifest keeps the verification field", () => {
    const parsed = parseDeliveryManifest(JSON.stringify(manifest({ checkedAt: "t", checkedBy: "tool", archiveExtras: 0, items: [], targets: [], report: { complete: true, failed: [] } })));
    expect(parsed?.verification?.checkedBy).toBe("tool");
    expect(parseDeliveryManifest("null")).toBeNull();
  });
});
