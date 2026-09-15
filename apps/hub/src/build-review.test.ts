import { describe, expect, test } from "bun:test";
import { panelPrincipals } from "@solutions-builder/app/kit";
import { reviewBuildEvidence } from "./build-review.js";
import type { CompletionRequest, CompletionResult } from "./inference.js";
import type { ArtifactDraft } from "./domain.js";

const ACTOR = { principalId: "p_test", displayName: "Test" };

function stubPersist() {
  const written: ArtifactDraft[] = [];
  const persist = async (draft: ArtifactDraft) => {
    written.push(draft);
    return { nodeId: `node-${written.length}`, artifactId: `artifact-${written.length}`, version: 1, contentHash: "0".repeat(64) };
  };
  return { persist, written };
}

describe("reviewBuildEvidence", () => {
  test("runs all four panel principals independently, each with its own system prompt and content", async () => {
    const systemsSeen: string[] = [];
    const { persist, written } = stubPersist();

    const completeFn = async (request: CompletionRequest): Promise<CompletionResult> => {
      systemsSeen.push(request.system);
      return {
        text: `## Verdict\nacceptable\n\n(from ${request.system.slice(0, 40)})`,
        providerId: "test-provider",
        model: "test-model",
        inputTokens: 10,
        outputTokens: 10,
      };
    };

    const results = await reviewBuildEvidence(
      {
        projectId: "proj-1",
        actor: ACTOR,
        planAndApprovedInputs: "(the plan)",
        evidence: "(the evidence)",
        sourceVersionIds: ["evidence-node-1"],
      },
      { completeFn, persist },
    );

    expect(results).toHaveLength(4);
    expect(new Set(results.map((r) => r.principal)).size).toBe(4);
    expect(results.every((r) => r.nodeId !== null && r.error === null)).toBe(true);

    // Every principal actually got its own distinct system prompt: four
    // independent principals, not one voice asked four times with the same
    // words.
    expect(new Set(systemsSeen).size).toBe(4);

    // Every written version is its own artifact, distinguished by variant,
    // never a merged document the four opinions were folded into.
    expect(written).toHaveLength(4);
    expect(new Set(written.map((d) => d.variant)).size).toBe(4);
    expect(written.every((d) => d.kind === "build_review")).toBe(true);
    expect(written.every((d) => d.sourceVersionIds.includes("evidence-node-1"))).toBe(true);

    const roleIds = panelPrincipals().map((role) => role.id);
    expect(new Set(results.map((r) => r.principal))).toEqual(new Set(roleIds));
  });

  test("one principal's failure does not stop the others from being recorded", async () => {
    const { persist, written } = stubPersist();
    let call = 0;
    const completeFn = async (): Promise<CompletionResult> => {
      call += 1;
      if (call === 2) return { text: "", providerId: "test-provider", model: "test-model", inputTokens: 0, outputTokens: 0 };
      return { text: "## Verdict\nacceptable\n", providerId: "test-provider", model: "test-model", inputTokens: 1, outputTokens: 1 };
    };

    const results = await reviewBuildEvidence(
      {
        projectId: "proj-1",
        actor: ACTOR,
        planAndApprovedInputs: "(the plan)",
        evidence: "(the evidence)",
        sourceVersionIds: ["evidence-node-1"],
      },
      { completeFn, persist },
    );

    expect(results).toHaveLength(4);
    const failed = results.filter((r) => r.error !== null);
    const succeeded = results.filter((r) => r.error === null);
    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(3);
    expect(written).toHaveLength(3);
  });
});
