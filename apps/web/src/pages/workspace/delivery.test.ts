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
  test("prefers an active delivery_verification over the manifest", () => {
    const verification = node({ id: "v", kind: "delivery_verification" });
    const manifest = node({ id: "m", kind: "delivery_manifest" });
    expect(findVerificationNode([manifest, verification])?.id).toBe("v");
  });

  test("falls back to the active delivery_manifest", () => {
    expect(findVerificationNode([node()])?.kind).toBe("delivery_manifest");
  });

  test("ignores superseded nodes and other stages", () => {
    const superseded = node({ id: "old", kind: "delivery_verification", supersededByNodeId: "v2" });
    const otherStage = node({ id: "s8", stage: 8, kind: "delivery_verification" });
    expect(findVerificationNode([superseded, otherStage])).toBeNull();
  });
});
