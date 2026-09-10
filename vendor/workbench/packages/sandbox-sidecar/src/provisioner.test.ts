import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAllocationStateStore,
  type AllocationStateStore,
} from "./state-store";
import { createSidecarProvisioner } from "./provisioner";
import type { SidecarBackend } from "./backend";

const TOKEN = "s3cr3t-bootstrap-token";

let dataDir: string;
let store: AllocationStateStore;
let started: string[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sandbox-sidecar-provisioner-"));
  store = createAllocationStateStore(join(dataDir, "state.json"));
  started = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function fakeBackend(): SidecarBackend {
  let counter = 0;
  return {
    async startUnit() {
      counter += 1;
      const externalRef = `unit-${String(counter)}`;
      started.push(externalRef);
      return externalRef;
    },
    async stopUnit() {},
    async findUnitsByAllocation() {
      return [];
    },
  };
}

function baseEnsureRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    allocationId: "alloc-1",
    generation: 0,
    tenantId: "tenant-1",
    anchorRunId: "run-1",
    sidecarId: "sidecar-1",
    token: TOKEN,
    hubWebSocketUrl: "wss://hub.example.com/ws",
    ...overrides,
  } as never;
}

function makeProvisioner(backend: SidecarBackend = fakeBackend()) {
  return createSidecarProvisioner({
    id: "test-provisioner",
    apiVersion: 1,
    bindingFingerprint: "test",
    capabilities: [],
    backend,
    store,
  });
}

describe("ensure request validation", () => {
  test("accepts generation 0, the allocation service's initial generation", async () => {
    const provisioner = makeProvisioner();

    const result = await provisioner.ensure(
      baseEnsureRequest({ generation: 0 }),
    );

    expect(result).toEqual({ kind: "accepted", externalRef: "unit-1" });
  });

  test("accepts a later generation", async () => {
    const provisioner = makeProvisioner();

    await provisioner.ensure(baseEnsureRequest({ generation: 0 }));
    const result = await provisioner.ensure(
      baseEnsureRequest({ generation: 1 }),
    );

    expect(result).toEqual({ kind: "accepted", externalRef: "unit-2" });
  });

  test("rejects a negative generation", async () => {
    const provisioner = makeProvisioner();

    const result = await provisioner.ensure(
      baseEnsureRequest({ generation: -1 }),
    );

    expect(result).toMatchObject({
      kind: "rejected",
      code: "invalid_ensure_request",
    });
    expect(started).toHaveLength(0);
  });

  test("rejects a non-integer generation", async () => {
    const provisioner = makeProvisioner();

    const result = await provisioner.ensure(
      baseEnsureRequest({ generation: 1.5 }),
    );

    expect(result).toMatchObject({
      kind: "rejected",
      code: "invalid_ensure_request",
    });
    expect(started).toHaveLength(0);
  });

  test("still rejects a stale generation once fencing has observed a later one", async () => {
    const provisioner = makeProvisioner();

    await provisioner.ensure(baseEnsureRequest({ generation: 1 }));
    const result = await provisioner.ensure(
      baseEnsureRequest({ generation: 0 }),
    );

    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
    });
    expect(started).toHaveLength(1);
  });
});

describe("destroy request validation", () => {
  test("accepts generation 0", async () => {
    const provisioner = makeProvisioner();
    await provisioner.ensure(baseEnsureRequest({ generation: 0 }));

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 0,
    });

    expect(result).toEqual({ kind: "destroyed" });
  });

  test("rejects a negative generation", async () => {
    const provisioner = makeProvisioner();

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: -1,
    });

    expect(result).toMatchObject({
      kind: "rejected",
      code: "invalid_destroy_request",
    });
  });
});
