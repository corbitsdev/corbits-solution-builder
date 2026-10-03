import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { findArtifact, listProjectArtifacts } from "./project-artifacts.ts";
import { mailTenantFor, resetTenantCache } from "./project-tenants.ts";

const WORKSPACE = { id: "tnt_ws", name: "Workspace", slug: "ws", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", domain: "ws.example" };
const PROJECT_A = { id: "prj_a", name: "A", slug: "a", parentId: WORKSPACE.id, createdAt: "2026-01-02T00:00:00.000Z", domain: "a.example" };
const PROJECT_B = { id: "prj_b", name: "B", slug: "b", parentId: WORKSPACE.id, createdAt: "2026-01-02T00:00:00.000Z", domain: "b.example" };

type Row = { id: string; title: string; content: string; metadata: Record<string, unknown> | null; version: number; archivedAt: null; createdAt: string; updatedAt: string; source: { origin: string } };

function row(id: string, projectId: string, kind = "stage_draft"): Row {
  return { id, title: id, content: `${id} body`, metadata: { sb: { projectId, kind } }, version: 1, archivedAt: null, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", source: { origin: "text" } };
}

/** A hub whose artifact routes are strictly per tenant, as the real mount's are. */
function fakeHub(byTenant: Record<string, Row[]>): Transport & { reads: string[] } {
  const tenants = [WORKSPACE, PROJECT_A, PROJECT_B];
  const reads: string[] = [];
  return {
    reads,
    async fetch<T>(method: string, path: string): Promise<T> {
      reads.push(`${method} ${path}`);
      const [pathname, query] = path.split("?");
      const tenant = /^\/api\/tenants\/([^/]+)$/.exec(pathname!);
      if (method === "GET" && tenant) {
        const found = tenants.find((entry) => entry.id === tenant[1]);
        if (found) return found as T;
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      const list = /^\/api\/tenants\/([^/]+)\/artifacts$/.exec(pathname!);
      if (method === "GET" && list) {
        const kind = new URLSearchParams(query).get("kind");
        const rows = (byTenant[list[1]!] ?? []).filter((entry) => !kind || (entry.metadata as { sb?: { kind?: string } })?.sb?.kind === kind);
        return { artifacts: rows, nextCursor: null } as T;
      }
      const one = /^\/api\/tenants\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname!);
      if (method === "GET" && one) {
        const found = (byTenant[one[1]!] ?? []).find((entry) => entry.id === one[2]);
        if (found) return { artifact: found } as T;
        throw new ApiError(404, "not_found", "Artifact not found");
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport & { reads: string[] };
}

afterEach(() => resetTenantCache());

// #29: a project's artifacts are its own tenant's. What an older project
// still has in the workspace, labelled with its id, is read alongside; the
// label alone never lets another project's records in.
describe("listProjectArtifacts", () => {
  test("the project tenant's own rows, plus the workspace's labelled with this project", async () => {
    const hub = fakeHub({
      [PROJECT_A.id]: [row("own_1", PROJECT_A.id)],
      [WORKSPACE.id]: [row("legacy_a", PROJECT_A.id), row("legacy_b", PROJECT_B.id), row("unlabelled", "")],
    });
    const listed = await listProjectArtifacts(hub, PROJECT_A.id);
    expect(listed.map((entry) => entry.id)).toEqual(["own_1", "legacy_a"]);
  });

  test("one project's rows are not another's, whatever the label says", async () => {
    const hub = fakeHub({
      [PROJECT_A.id]: [row("a_claims_b", PROJECT_B.id)],
      [PROJECT_B.id]: [row("b_own", PROJECT_B.id)],
    });
    // A row in B's tenant is B's; a row in A's tenant labelled B is still A's, not B's.
    expect((await listProjectArtifacts(hub, PROJECT_B.id)).map((entry) => entry.id)).toEqual(["b_own"]);
    expect((await listProjectArtifacts(hub, PROJECT_A.id)).map((entry) => entry.id)).toEqual(["a_claims_b"]);
  });

  test("a kind filter applies to both reads", async () => {
    const hub = fakeHub({
      [PROJECT_A.id]: [row("own_material", PROJECT_A.id, "source_material"), row("own_draft", PROJECT_A.id)],
      [WORKSPACE.id]: [row("legacy_material", PROJECT_A.id, "source_material")],
    });
    const listed = await listProjectArtifacts(hub, PROJECT_A.id, { kind: "source_material" });
    expect(listed.map((entry) => entry.id)).toEqual(["own_material", "legacy_material"]);
  });

  test("the workspace itself reads only its own rows", async () => {
    const hub = fakeHub({ [WORKSPACE.id]: [row("ws_1", "")] });
    expect((await listProjectArtifacts(hub, WORKSPACE.id)).map((entry) => entry.id)).toEqual(["ws_1"]);
  });
});

describe("findArtifact", () => {
  test("found in the project tenant, the write target is the project tenant", async () => {
    const hub = fakeHub({ [PROJECT_A.id]: [row("own_1", PROJECT_A.id)] });
    expect(await findArtifact(hub, PROJECT_A.id, "own_1")).toMatchObject({ tenantId: PROJECT_A.id, artifact: { id: "own_1" } });
  });

  test("an older artifact still in the workspace is found there, and that is the write target", async () => {
    const hub = fakeHub({ [WORKSPACE.id]: [row("legacy_1", PROJECT_A.id)] });
    expect(await findArtifact(hub, PROJECT_A.id, "legacy_1")).toMatchObject({ tenantId: WORKSPACE.id, artifact: { id: "legacy_1" } });
  });

  test("null when neither holds it", async () => {
    expect(await findArtifact(fakeHub({}), PROJECT_A.id, "nope")).toBeNull();
  });
});

// #29: a specialist's mailbox is in the tenant whose domain its address
// carries -- the project's own, or the workspace's for one deployed there
// before specialists moved.
describe("mailTenantFor", () => {
  test("a project-domain address is the project's mailbox", async () => {
    expect(await mailTenantFor(fakeHub({}), PROJECT_A.id, "run_1@a.example")).toBe(PROJECT_A.id);
  });

  test("a workspace-domain address is the workspace's mailbox", async () => {
    expect(await mailTenantFor(fakeHub({}), PROJECT_A.id, "run_1@WS.example")).toBe(WORKSPACE.id);
  });

  test("an unknown domain stays with the tenant given, for the hub to answer", async () => {
    expect(await mailTenantFor(fakeHub({}), PROJECT_A.id, "run_1@elsewhere.example")).toBe(PROJECT_A.id);
  });
});
