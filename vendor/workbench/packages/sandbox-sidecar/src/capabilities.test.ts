import { SidecarCapabilityDeclaration } from "@intx/types";
import { type } from "arktype";
import { describe, expect, test } from "bun:test";

import { sidecarCapabilityDeclarations } from "./capabilities";

describe("sidecarCapabilityDeclarations", () => {
  test("every backend's declarations parse as Interchange declarations", () => {
    for (const isolation of ["process", "container", "vm"] as const) {
      const parsed = SidecarCapabilityDeclaration.array()(
        sidecarCapabilityDeclarations(isolation),
      );
      expect(parsed instanceof type.errors).toBe(false);
    }
  });

  test("the process backend blocks container and vm isolation", () => {
    expect(sidecarCapabilityDeclarations("process")).toEqual([
      { capability: "runtime:sidecar", state: "available" },
      { capability: "isolation:process", state: "available" },
      { capability: "isolation:container", state: "blocked" },
      { capability: "isolation:vm", state: "blocked" },
    ]);
  });

  test("a container reaches process isolation but not vm isolation", () => {
    expect(sidecarCapabilityDeclarations("container")).toEqual([
      { capability: "runtime:sidecar", state: "available" },
      { capability: "isolation:process", state: "available" },
      { capability: "isolation:container", state: "available" },
      { capability: "isolation:vm", state: "blocked" },
    ]);
  });

  test("a vm reaches every rung of the ladder", () => {
    expect(
      sidecarCapabilityDeclarations("vm").every(
        ({ state }) => state === "available",
      ),
    ).toBe(true);
  });
});
