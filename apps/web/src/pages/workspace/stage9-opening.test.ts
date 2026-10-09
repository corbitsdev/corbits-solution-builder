import { describe, expect, test } from "bun:test";
import { ApiFailure, type ArtifactNode } from "../../client.js";
import { composeStage9Opening, type Stage9OpeningReads } from "./stage9-opening.ts";

const archive: ArtifactNode = {
  id: "n-archive",
  kind: "build_evidence",
  variant: "attempt-1",
  stage: 8,
  title: "Build archive",
  version: 1,
  position: 1,
  artifactId: "art-archive",
  contentHash: "art-archive@1",
  createdAt: "2026-10-01T00:00:00.000Z",
  supersededByNodeId: null,
  provenance: { producer: "tool" },
};
const manifest: ArtifactNode = { ...archive, id: "n-manifest", kind: "delivery_manifest", title: "Delivery manifest", artifactId: "art-manifest" };
const archiveRef = { artifactId: archive.artifactId, version: archive.version };
const down = new ApiFailure({ code: "unavailable", message: "the hub is down", correlationId: "c1", retryable: true });

const reads = (over: Partial<Stage9OpeningReads>): Stage9OpeningReads => ({
  artifactContent: async () => ({ content: "{}" }),
  stageAgentStatus: async () => null,
  readStageThread: async () => [],
  ...over,
});

// #570: a read that fails fails the opening, which is shown and tried again;
// sent without what it could not read, the opening's marker stood for good.
describe("composeStage9Opening", () => {
  test("a manifest that cannot be read fails the opening with the reason", async () => {
    const compose = composeStage9Opening({
      tenantId: "tnt",
      projectId: "prj",
      nodes: [archive, manifest],
      archiveRef,
      reads: reads({
        artifactContent: async () => {
          throw down;
        },
      }),
    });
    await expect(compose).rejects.toThrow("The delivery manifest could not be read: the hub is down");
  });

  test("Build and test's status that cannot be read fails the opening on a reload", async () => {
    const compose = composeStage9Opening({
      tenantId: "tnt",
      projectId: "prj",
      nodes: [],
      archiveRef: null,
      reads: reads({
        stageAgentStatus: async () => {
          throw down;
        },
      }),
    });
    await expect(compose).rejects.toThrow("Build and test's status could not be read: the hub is down");
  });

  test("in session the status reply just approved stands in for a status read that fails", async () => {
    const opening = await composeStage9Opening({
      tenantId: "tnt",
      projectId: "prj",
      nodes: [],
      archiveRef: null,
      fallbackBuildStatusBody: "All checks passed on the host.",
      reads: reads({
        stageAgentStatus: async () => {
          throw down;
        },
      }),
    });
    expect(opening).toContain("All checks passed on the host.");
  });

  test("nothing to read is still said plainly", async () => {
    const opening = await composeStage9Opening({ tenantId: "tnt", projectId: "prj", nodes: [], archiveRef: null, reads: reads({}) });
    expect(opening).toContain("No delivery manifest artifact is available");
    expect(opening).toContain("No build status text was found.");
  });
});
