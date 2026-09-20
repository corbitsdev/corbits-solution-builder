import { describe, expect, test } from "bun:test";
import { actionableApprovals, approvalsPath, deliveryApprovalFor, type PendingApproval } from "./pending-approvals.ts";

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "apr_1",
    anchorRunId: "dep_1",
    runId: "dep_1",
    status: "pending",
    toolDefinition: { name: "deliver" },
    toolArguments: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deliveryApprovalFor", () => {
  test("finds the pending deliver approval on this run", () => {
    const found = deliveryApprovalFor([approval()], "dep_1");
    expect(found?.id).toBe("apr_1");
  });

  test("ignores approvals on another run", () => {
    expect(deliveryApprovalFor([approval({ anchorRunId: "dep_2" })], "dep_1")).toBeNull();
  });

  test("ignores a resolved approval", () => {
    expect(deliveryApprovalFor([approval({ status: "approved" })], "dep_1")).toBeNull();
  });

  test("ignores a pending approval on a different tool", () => {
    expect(deliveryApprovalFor([approval({ toolDefinition: { name: "delivery_status" } })], "dep_1")).toBeNull();
  });
});

describe("approvalsPath", () => {
  test("is the stock hub route, not a host-specific one", () => {
    expect(approvalsPath("tnt_ws")).toBe("/api/tenants/tnt_ws/approvals");
  });
});

describe("actionableApprovals", () => {
  test("uses the anchor, including tool calls in nested runs", () => {
    expect(actionableApprovals([approval({ runId: "child" })], [{ id: "dep_1", status: "deployed" }])).toHaveLength(1);
  });
  test("retains durable decisions through provisioning and recovery", () => {
    for (const status of ["pending", "recovering"]) {
      expect(actionableApprovals([approval()], [{ id: "dep_1", status }])).toHaveLength(1);
    }
  });
  test("omits released, failed, unknown and resolved requests", () => {
    for (const status of ["releasing", "released", "failed", "destroy_failed", "unknown"]) {
      expect(actionableApprovals([approval()], [{ id: "dep_1", status }])).toEqual([]);
    }
    expect(actionableApprovals([approval()], [])).toEqual([]);
    expect(actionableApprovals([approval({ status: "approved" })], [{ id: "dep_1", status: "deployed" }])).toEqual([]);
  });
});
