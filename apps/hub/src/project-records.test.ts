import { describe, expect, test } from "bun:test";
import { projectRecordFromTenant } from "./project-records.js";

describe("projectRecordFromTenant", () => {
  test("reads a live project out of the tenant config the installer writes", () => {
    const record = projectRecordFromTenant({
      id: "tnt_abc",
      name: "Chess",
      createdAt: "2026-01-02T00:00:00.000Z",
      config: {
        solutionsBuilder: {
          policy: {
            costTolerancePercent: 10,
            costToleranceAbsolute: 100,
            audiences: [{ name: "You", role: "project_owner" }],
            audienceQuorum: 1,
            allowExternalProviders: false,
          },
          policyVersion: 1,
          revision: 3,
          archivedAt: null,
          deletedAt: null,
        },
      },
    });
    expect(record).not.toBeNull();
    expect(record!.id).toBe("tnt_abc");
    expect(record!.title).toBe("Chess");
    expect(record!.revision).toBe(3);
    expect(record!.policy.audiences[0]!.name).toBe("You");
    expect(record!.deletedAt).toBeNull();
  });

  test("ignores a child tenant that is not a project", () => {
    expect(
      projectRecordFromTenant({
        id: "tnt_other",
        name: "Something else",
        createdAt: new Date(),
        config: {},
      }),
    ).toBeNull();
  });
});
