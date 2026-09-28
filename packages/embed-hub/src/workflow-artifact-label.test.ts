import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { labelWorkflowArtifactBody, labelWorkflowArtifacts } from "./workflow-artifact-label.js";

const SCOPE = { tenantId: "prj_tenant", principalId: "p_run", runId: "run_1" };

// #41 step 5: the project a run's record belongs to is the run's tenant,
// stamped by the hub from the resolved scope, never taken from the writer.
describe("labelWorkflowArtifactBody", () => {
  test("stamps sb.projectId from the tenant, overriding a claimed one", () => {
    const body = { title: "t", kind: "build_evidence", metadata: { sb: { kind: "build_evidence", stage: 8, projectId: "someone_else" } } };
    expect(labelWorkflowArtifactBody(body, "prj_tenant")).toEqual({
      title: "t",
      kind: "build_evidence",
      metadata: { sb: { kind: "build_evidence", stage: 8, projectId: "prj_tenant" } },
    });
    expect(body.metadata.sb.projectId).toBe("someone_else");
  });

  test("leaves a body with no sb record, or no metadata, alone", () => {
    expect(labelWorkflowArtifactBody({ title: "t", kind: "note", content: "x" }, "prj_tenant")).toEqual({ title: "t", kind: "note", content: "x" });
    expect(labelWorkflowArtifactBody({ title: "t", metadata: { other: 1 } }, "prj_tenant")).toEqual({ title: "t", metadata: { other: 1 } });
    expect(labelWorkflowArtifactBody("not an object", "prj_tenant")).toBe("not an object");
  });
});

describe("labelWorkflowArtifacts", () => {
  function app(resolved: typeof SCOPE | null) {
    const seen: string[] = [];
    const hono = new Hono();
    hono.use("/artifacts", labelWorkflowArtifacts(async (token, address) => {
      seen.push(`${token}@${address}`);
      return resolved;
    }));
    hono.post("/artifacts", async (c) => c.json(await c.req.json()));
    hono.get("/artifacts", (c) => c.json({ listed: true }));
    return { hono, seen };
  }

  const headers = { authorization: "Bearer tok", "x-workflow-run-address": "run@sb.local", "content-type": "application/json" };

  test("the route reads the stamped body", async () => {
    const { hono, seen } = app(SCOPE);
    const response = await hono.request("/artifacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "bundle", metadata: { sb: { kind: "build_evidence", stage: 8 } } }),
    });
    expect(await response.json()).toEqual({ title: "bundle", metadata: { sb: { kind: "build_evidence", stage: 8, projectId: "prj_tenant" } } });
    expect(seen).toEqual(["tok@run@sb.local"]);
  });

  test("a request the resolver cannot place passes through unstamped, for the mount to refuse", async () => {
    const { hono } = app(null);
    const response = await hono.request("/artifacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "bundle", metadata: { sb: { kind: "build_evidence", stage: 8 } } }),
    });
    expect(await response.json()).toEqual({ title: "bundle", metadata: { sb: { kind: "build_evidence", stage: 8 } } });
  });

  test("reads are not touched", async () => {
    const { hono, seen } = app(SCOPE);
    const response = await hono.request("/artifacts", { method: "GET", headers });
    expect(await response.json()).toEqual({ listed: true });
    expect(seen).toEqual([]);
  });
});
