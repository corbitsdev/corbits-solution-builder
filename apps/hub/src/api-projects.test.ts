import { describe, expect, test } from "bun:test";
import { createApi } from "./api.js";

describe("host project tenant mutations", () => {
  test("PATCH, DELETE and stakeholders/delegations routes are gone; open, material and export stay", async () => {
    const source = await Bun.file(new URL("./api-projects.ts", import.meta.url)).text();
    expect(source).not.toContain('api.patch("/projects/:projectId"');
    expect(source).not.toContain('api.delete("/projects/:projectId",');
    expect(source).not.toContain('api.put("/projects/:projectId/stakeholders"');
    expect(source).not.toContain('api.get("/projects/:projectId/stakeholders"');
    expect(source).not.toContain('/projects/:projectId/delegations"');
    expect(source).toContain('api.post("/projects/:projectId/open"');
    expect(source).toContain('api.post("/projects/:projectId/material"');
    expect(source).toContain('api.post("/projects/:projectId/export"');
  });

  test("those dropped routes 404", async () => {
    const api = createApi();
    const patch = await api.request("/projects/proj-1", { method: "PATCH", body: "{}" });
    const del = await api.request("/projects/proj-1", { method: "DELETE" });
    const put = await api.request("/projects/proj-1/stakeholders", { method: "PUT", body: "{}" });
    const get = await api.request("/projects/proj-1/stakeholders");
    const delegations = await api.request("/projects/proj-1/delegations");
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    expect(put.status).toBe(404);
    expect(get.status).toBe(404);
    expect(delegations.status).toBe(404);
  });
});
