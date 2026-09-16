// Terminal-event attribution guard (upstream INTR-548).
//
// A loop-iteration child run (`<anchor>__revise-N__M`) whose ROUND gate is a
// plain author-named awaitSignal parks silently by design -- `onPark` fires
// only for reserved-channel suspends -- so it never crosses the
// correlation-register path that lazily mints internal run rows. Its terminal
// event must therefore mint the missing row and flip it, not be misread as a
// foreign run. Only a row that exists with a genuinely different anchorRunId
// is foreign and stays a loud ignore.
//
// These tests drive the real `receiveWorkflowRunPack` with a scripted
// in-memory executor: no Postgres, no git repo. The executor records every
// insert/update so each case asserts on the store calls the guard did or
// pointedly did not make.

import { describe, test, expect } from "bun:test";

import { workflowRun } from "@intx/db/schema";
import { deriveWorkflowRunRepoId } from "@intx/workflow-deploy";

import { createHubSessionLookups } from "./hub-session-lookups";

const ANCHOR_ID = "run_abc123";
const AGENT_ADDRESS = `${ANCHOR_ID}@tenant.example`;
const TENANT_ID = "tenant-1";
const DEFINITION_ID = "def-1";
const CHILD_RUN_ID = `${ANCHOR_ID}__revise-1__0`;

const anchorRow = {
  id: ANCHOR_ID,
  address: AGENT_ADDRESS,
  anchorRunId: ANCHOR_ID,
  tenantId: TENANT_ID,
  definitionId: DEFINITION_ID,
};

const allocationRow = {
  id: "alloc-1",
  anchorRunId: ANCHOR_ID,
  status: "allocated",
  generation: 7,
  ensureAcceptedGeneration: 7,
};

const source = {
  agentAddress: AGENT_ADDRESS,
  allocationId: "alloc-1",
  anchorRunId: ANCHOR_ID,
  generation: 7,
};

function fullRunRow(overrides: Record<string, unknown>) {
  return {
    id: CHILD_RUN_ID,
    anchorRunId: ANCHOR_ID,
    definitionId: DEFINITION_ID,
    tenantId: TENANT_ID,
    principalId: null,
    status: "running",
    address: null,
    publicKey: null,
    sidecarId: null,
    kernelId: null,
    modelPreferences: null,
    credentialRefs: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    endedAt: null,
    ...overrides,
  };
}

type Script = {
  ownedRunRows: unknown[];
};

function createHarness(script: Script) {
  const inserts: { table: unknown; row: unknown }[] = [];
  const updates: { table: unknown; set: unknown }[] = [];

  const terminal = (rows: unknown[]) => {
    const chain: Record<string, (...args: never[]) => unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => chain;
    chain.for = () => Promise.resolve(rows);
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  };

  const tx = {
    select: (columns?: Record<string, unknown>) => {
      if (columns === undefined) return terminal([allocationRow]);
      if ("anchorRunId" in columns) return terminal(script.ownedRunRows);
      return terminal([]);
    },
    insert: (table: unknown) => ({
      values: (row: unknown) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            inserts.push({ table, row });
            return Promise.resolve([fullRunRow(row as Record<string, unknown>)]);
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: () => ({
          returning: () => {
            updates.push({ table, set });
            return Promise.resolve([
              fullRunRow({ status: (set as { status: string }).status }),
            ]);
          },
        }),
      }),
    }),
  };

  const db = {
    select: () => terminal([anchorRow]),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  };

  const agentRepoStore = {
    receiveWorkflowRunPack: async () => [
      { runId: CHILD_RUN_ID, status: "completed" as const },
    ],
    repoStore: {
      openCommittedReads: async () => null,
    },
  };

  const lookups = createHubSessionLookups({
    db: db as never,
    agentRepoStore: agentRepoStore as never,
  });

  return { lookups, inserts, updates };
}

async function receivePack(lookups: {
  receiveWorkflowRunPack: (...args: never[]) => Promise<unknown>;
}) {
  return lookups.receiveWorkflowRunPack(
    {
      kind: "workflow-run",
      id: deriveWorkflowRunRepoId(AGENT_ADDRESS),
    } as never,
    {} as never,
    "refs/heads/events" as never,
    "abc123" as never,
    source as never,
  );
}

describe("terminal-event attribution guard", () => {
  test("missing row is minted and flipped, not ignored as foreign", async () => {
    const { lookups, inserts, updates } = createHarness({ ownedRunRows: [] });

    const result = await receivePack(lookups);

    expect(result).toEqual({ accepted: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(workflowRun);
    expect(inserts[0]?.row).toMatchObject({
      id: CHILD_RUN_ID,
      anchorRunId: ANCHOR_ID,
      definitionId: DEFINITION_ID,
      tenantId: TENANT_ID,
      principalId: null,
      status: "running",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.table).toBe(workflowRun);
    expect(updates[0]?.set).toMatchObject({ status: "completed" });
  });

  test("row anchored to another deployment is loudly ignored", async () => {
    const { lookups, inserts, updates } = createHarness({
      ownedRunRows: [{ anchorRunId: "run_other" }],
    });

    const result = await receivePack(lookups);

    expect(result).toEqual({ accepted: true });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
