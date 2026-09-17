import { describe, test, expect } from "bun:test";
import { delivery, TOOL_NAME } from "./sidecar-bundle.js";

const controller = new AbortController();
const bundle = delivery({} as never);

function call(id: string, args: Record<string, unknown>) {
  return bundle.run({ id, name: TOOL_NAME, arguments: args }, controller.signal);
}

describe("delivery_status", () => {
  test("a complete manifest reports complete with no blockers", async () => {
    const result = await call("1", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "source", path: "src/index.ts", required: true, status: "verified" }],
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content as string) as { report: { complete: boolean }; blockers: string | null };
    expect(parsed.report.complete).toBe(true);
    expect(parsed.blockers).toBeNull();
  });

  test("a missing required descriptor reports incomplete with a blocker sentence", async () => {
    const result = await call("2", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "source", path: "src/index.ts", required: true, status: "missing" }],
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content as string) as { report: { complete: boolean; failed: string[] }; blockers: string | null };
    expect(parsed.report.complete).toBe(false);
    expect(parsed.report.failed).toEqual(["src/index.ts"]);
    expect(parsed.blockers).toContain("src/index.ts");
  });

  test("an unrequired descriptor's status does not block completeness", async () => {
    const result = await call("3", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "docs", path: "README.md", required: false, status: "missing" }],
    });
    const parsed = JSON.parse(result.content as string) as { report: { complete: boolean } };
    expect(parsed.report.complete).toBe(true);
  });

  test("a missing manifestNodeId is an error, not a thrown exception", async () => {
    const result = await call("4", { checkedAt: "2026-01-01T00:00:00.000Z", items: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("manifestNodeId");
  });

  test("a missing checkedAt is an error", async () => {
    const result = await call("5", { manifestNodeId: "nod_manifest", items: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("checkedAt");
  });

  test("items must be an array", async () => {
    const result = await call("6", { manifestNodeId: "nod_manifest", checkedAt: "2026-01-01T00:00:00.000Z", items: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("items");
  });

  test("an item with an unknown category is an error", async () => {
    const result = await call("7", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "nonsense", path: "a", required: true, status: "verified" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("category");
  });

  test("an item with an unknown status is an error", async () => {
    const result = await call("8", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "source", path: "a", required: true, status: "nonsense" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status");
  });

  test("an item with a non-boolean required is an error", async () => {
    const result = await call("9", {
      manifestNodeId: "nod_manifest",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [{ category: "source", path: "a", required: "yes", status: "verified" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  test("the tool's own id is namespaced under @solutions-builder/tools-delivery", () => {
    expect(delivery.id).toBe("@solutions-builder/tools-delivery/delivery-status");
  });
});
