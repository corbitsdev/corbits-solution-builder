import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import { extractHowToRun, findVerificationNode } from "./delivery.tsx";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "delivery_manifest",
    variant: null,
    stage: 9,
    title: "Delivery manifest",
    version: 1,
    artifactId: "art_1",
    contentHash: "sha256:abc",
    mediaType: "application/json",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    ...overrides,
  };
}

describe("extractHowToRun", () => {
  test("returns null when there is no how-to-run heading", () => {
    expect(extractHowToRun(null)).toBeNull();
    expect(extractHowToRun("The package is ready.")).toBeNull();
  });

  test("pulls the how-to-run section and stops at the next heading", () => {
    const body = [
      "Checks passed.",
      "",
      "## How to run it",
      "bun run start",
      "",
      "## Notes",
      "Ignore this.",
    ].join("\n");
    expect(extractHowToRun(body)).toBe("## How to run it\n\nbun run start");
  });
});

describe("findVerificationNode", () => {
  // #129: the checks live on the manifest `publish_workspace` wrote beside
  // the approved stage 8 archive, matched by attempt the way the stage 9
  // opening matches it -- never the newest manifest of some other attempt.
  test("prefers the approved stage 8 archive's own manifest companion", () => {
    const archive = node({ id: "a", kind: "build_evidence", stage: 8, variant: "attempt-2", artifactId: "art_archive", version: 3, mediaType: "application/gzip" });
    const companion = node({ id: "m2", kind: "delivery_manifest", stage: 8, variant: "attempt-2" });
    const otherAttempt = node({ id: "m3", kind: "delivery_manifest", stage: 8, variant: "attempt-3", createdAt: "2026-02-01T00:00:00.000Z" });
    const stage9 = node({ id: "v", kind: "delivery_verification" });
    expect(findVerificationNode([stage9, otherAttempt, companion, archive], { artifactId: "art_archive", version: 3 })?.id).toBe("m2");
  });

  test("without an approved archive, prefers an active stage 9 delivery_verification over the manifest", () => {
    const verification = node({ id: "v", kind: "delivery_verification" });
    const manifest = node({ id: "m", kind: "delivery_manifest" });
    expect(findVerificationNode([manifest, verification], null)?.id).toBe("v");
  });

  test("falls back to the active stage 9 delivery_manifest", () => {
    expect(findVerificationNode([node()], null)?.kind).toBe("delivery_manifest");
  });

  test("ignores superseded nodes and a stage 8 record that is not the archive's companion", () => {
    const superseded = node({ id: "old", kind: "delivery_verification", supersededByNodeId: "v2" });
    const otherStage = node({ id: "s8", stage: 8, kind: "delivery_verification" });
    expect(findVerificationNode([superseded, otherStage], null)).toBeNull();
    expect(findVerificationNode([superseded, otherStage], { artifactId: "art_none", version: 1 })).toBeNull();
  });
});
