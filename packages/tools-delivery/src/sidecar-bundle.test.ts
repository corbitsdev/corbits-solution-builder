import { describe, test, expect } from "bun:test";
import { deliver, DELIVER_TOOL_NAME } from "./sidecar-bundle.js";

const controller = new AbortController();
const bundle = deliver({} as never);

function call(id: string, args: Record<string, unknown>) {
  return bundle.run({ id, name: DELIVER_TOOL_NAME, arguments: args }, controller.signal);
}

describe("deliver", () => {
  test("confirms the submission it was approved with", async () => {
    const result = await call("1", {
      manifestNodeId: "nod_manifest",
      summary: "The workout log, built and checked.",
      artifacts: [{ path: "build.tar.gz", contentHash: "abc" }],
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("Delivered manifest nod_manifest: The workout log, built and checked.");
  });

  test("a missing manifestNodeId is an error, not a thrown exception", async () => {
    const result = await call("2", { summary: "x", artifacts: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("manifestNodeId");
  });

  test("a missing summary is an error", async () => {
    const result = await call("3", { manifestNodeId: "nod_manifest", artifacts: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("summary");
  });

  test("artifacts must be an array of path and contentHash", async () => {
    expect((await call("4", { manifestNodeId: "nod_manifest", summary: "x", artifacts: "nope" })).isError).toBe(true);
    const bad = await call("5", { manifestNodeId: "nod_manifest", summary: "x", artifacts: [{ path: "a" }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("contentHash");
  });

  test("the tool asks for a person's approval and is namespaced under @solutions-builder/tools-delivery", () => {
    expect(deliver.id).toBe("@solutions-builder/tools-delivery/deliver");
    expect(deliver.definitions).toEqual([{ name: DELIVER_TOOL_NAME, approval: "ask" }]);
  });
});
