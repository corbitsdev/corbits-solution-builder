import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAllocationStateStore } from "./state-store";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "docker-provisioner-state-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function statePath(): string {
  return join(dataDir, "state.json");
}

describe("observeEnsure", () => {
  test("accepts the first ensure for an allocation", async () => {
    const store = createAllocationStateStore(statePath());
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result.kind).toBe("observed");
  });

  test("accepts generation 0, the allocation service's initial generation", async () => {
    const store = createAllocationStateStore(statePath());
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 0,
    });
    expect(result.kind).toBe("observed");
  });

  test("is idempotent when observed again at the same generation", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result.kind).toBe("observed");
  });

  test("rejects a generation older than one already observed", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 3,
    });
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
    });
  });

  test("rejects an ensure after that generation was destroyed", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "generation_destroyed",
    });
  });

  test("rejects a delayed ensure for a generation older than a tombstoned one", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
    });
  });

  test("rejects when the sidecarId does not match the bound allocation", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    const result = await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-2",
      generation: 2,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "request_conflict",
    });
  });
});

describe("observeDestroy", () => {
  test("is idempotent once tombstoned", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    const result = await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result.kind).toBe("observed");
  });

  test("rejects a destroy generation older than one already observed", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 3,
    });
    const result = await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
    });
  });

  test("carries the recorded externalRef into the tombstone", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.recordUnit({
      allocationId: "alloc-1",
      generation: 1,
      externalRef: "container-abc",
      tokenHashSha256: "deadbeef",
    });
    const result = await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    expect(result).toMatchObject({
      kind: "observed",
      record: { externalRef: "container-abc" },
    });
  });
});

describe("recordUnit", () => {
  test("fails when the allocation was superseded by a newer generation", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });
    const recorded = await store.recordUnit({
      allocationId: "alloc-1",
      generation: 1,
      externalRef: "container-abc",
      tokenHashSha256: "deadbeef",
    });
    expect(recorded).toBe(false);
  });

  test("fails when the allocation was destroyed before the docker run finished", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.observeDestroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    const recorded = await store.recordUnit({
      allocationId: "alloc-1",
      generation: 1,
      externalRef: "container-abc",
      tokenHashSha256: "deadbeef",
    });
    expect(recorded).toBe(false);
  });

  test("persists the externalRef and token hash to disk", async () => {
    const store = createAllocationStateStore(statePath());
    await store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    });
    await store.recordUnit({
      allocationId: "alloc-1",
      generation: 1,
      externalRef: "container-abc",
      tokenHashSha256: "deadbeef",
    });
    const raw = JSON.parse(await readFile(statePath(), "utf8"));
    expect(raw.records[0].externalRef).toBe("container-abc");
    expect(raw.records[0].tokenHashSha256).toBe("deadbeef");
  });
});

test("state survives reload from a fresh store instance", async () => {
  const store = createAllocationStateStore(statePath());
  await store.observeEnsure({
    allocationId: "alloc-1",
    sidecarId: "sidecar-1",
    generation: 5,
  });

  const reloaded = createAllocationStateStore(statePath());
  const result = await reloaded.observeEnsure({
    allocationId: "alloc-1",
    sidecarId: "sidecar-1",
    generation: 4,
  });
  expect(result).toMatchObject({
    kind: "rejected",
    code: "stale_generation",
  });
});

test("the highest generation of concurrent writes wins", async () => {
  const store = createAllocationStateStore(statePath());
  const results = await Promise.all([
    store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 1,
    }),
    store.observeEnsure({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    }),
  ]);
  expect(results.every((result) => result.kind === "observed")).toBe(true);
  const record = await store.getRecord("alloc-1");
  expect(record?.generation).toBe(2);
});
