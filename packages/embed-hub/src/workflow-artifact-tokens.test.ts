import { describe, expect, test } from "bun:test";
import { decideWorkflowArtifactRunScope } from "./workflow-artifact-tokens.js";

const TOKEN = { tenantId: "t_a", anchorRunId: "run_anchor" };

describe("decideWorkflowArtifactRunScope", () => {
  test("null token or run refuses", () => {
    expect(decideWorkflowArtifactRunScope(null, { id: "run_anchor", tenantId: "t_a", anchorRunId: null, principalId: "p_1" }, null)).toBeNull();
    expect(decideWorkflowArtifactRunScope(TOKEN, null, null)).toBeNull();
  });

  test("token tenant does not match run tenant -> null", () => {
    const run = { id: "run_anchor", tenantId: "t_b", anchorRunId: null, principalId: "p_1" };
    expect(decideWorkflowArtifactRunScope(TOKEN, run, null)).toBeNull();
  });

  test("run is neither the anchor nor a descendant of it -> null", () => {
    const run = { id: "run_other", tenantId: "t_a", anchorRunId: "run_other_anchor", principalId: "p_1" };
    expect(decideWorkflowArtifactRunScope(TOKEN, run, null)).toBeNull();
  });

  test("happy path: run is the anchor itself", () => {
    const run = { id: "run_anchor", tenantId: "t_a", anchorRunId: null, principalId: "p_1" };
    expect(decideWorkflowArtifactRunScope(TOKEN, run, null)).toEqual({
      tenantId: "t_a",
      principalId: "p_1",
      runId: "run_anchor",
    });
  });

  test("happy path: run is a descendant (child/loop-iteration) of the anchor", () => {
    const run = { id: "run_child_1", tenantId: "t_a", anchorRunId: "run_anchor", principalId: null };
    expect(decideWorkflowArtifactRunScope(TOKEN, run, "p_anchor")).toEqual({
      tenantId: "t_a",
      principalId: "p_anchor",
      runId: "run_child_1",
    });
  });

  test("descendant run with no principal anywhere -> null", () => {
    const run = { id: "run_child_1", tenantId: "t_a", anchorRunId: "run_anchor", principalId: null };
    expect(decideWorkflowArtifactRunScope(TOKEN, run, null)).toBeNull();
  });
});
