import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { createArtifact, getArtifact, listArtifacts, reviseArtifact, type Artifact } from "./artifacts.js";

const TENANT_ID = "t_test";

/** A fake `/artifacts` collection: enough of the mounted module's shape to test the client against. */
function fakeTransport(): Transport {
  const rows = new Map<string, Artifact>();
  let counter = 0;
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const [pathname, query] = path.split("?");
      const prefix = `/api/tenants/${TENANT_ID}`;
      if (method === "POST" && pathname === `${prefix}/artifacts`) {
        const input = body as { title: string; content: string };
        counter += 1;
        const artifact: Artifact = {
          id: `art_${counter}`,
          kind: "document",
          title: input.title,
          source: { origin: "manual" },
          version: 1,
          ownerPrincipalId: "p_test",
          metadata: null,
          archivedAt: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          content: input.content,
        };
        rows.set(artifact.id, artifact);
        return { artifact } as T;
      }
      if (method === "GET" && pathname === `${prefix}/artifacts`) {
        const params = new URLSearchParams(query);
        expect(params.get("limit")).toBe("100");
        return { artifacts: [...rows.values()], nextCursor: null } as T;
      }
      const detailMatch = pathname?.match(/\/artifacts\/([^/]+)$/);
      if (method === "GET" && detailMatch) {
        const row = rows.get(detailMatch[1]!);
        if (!row) throw new Error("not found");
        return { artifact: row } as T;
      }
      const versionMatch = pathname?.match(/\/artifacts\/([^/]+)\/versions$/);
      if (method === "POST" && versionMatch) {
        const row = rows.get(versionMatch[1]!);
        if (!row) throw new Error("not found");
        const input = body as { title?: string; content?: string };
        const revised: Artifact = {
          ...row,
          version: row.version + 1,
          title: input.title ?? row.title,
          content: input.content ?? row.content,
        };
        rows.set(row.id, revised);
        return revised as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as Transport;
}

describe("artifacts client", () => {
  test("writes an artifact and lists it back", async () => {
    const transport = fakeTransport();
    const written = await createArtifact(transport, TENANT_ID, { title: "Plan", content: "the plan" });
    expect(written.version).toBe(1);

    const listed = await listArtifacts(transport, TENANT_ID);
    expect(listed.map((row) => row.id)).toEqual([written.id]);
  });

  test("gets an artifact by id, and null when absent", async () => {
    const transport = fakeTransport();
    const written = await createArtifact(transport, TENANT_ID, { title: "Plan", content: "v1" });

    const fetched = await getArtifact(transport, TENANT_ID, written.id);
    expect(fetched?.content).toBe("v1");
    expect(await getArtifact(transport, TENANT_ID, "art_missing")).toBeNull();
  });

  test("revises an artifact, bumping its version", async () => {
    const transport = fakeTransport();
    const written = await createArtifact(transport, TENANT_ID, { title: "Plan", content: "v1" });

    const revised = await reviseArtifact(transport, TENANT_ID, written.id, { content: "v2" });
    expect(revised.version).toBe(2);
    expect(revised.content).toBe("v2");
  });
});
