import { describe, expect, test } from "bun:test";
import { parseDeliveryVerification } from "./delivery-verification.ts";

describe("parseDeliveryVerification", () => {
  test("reads the delivery_status tool-argument shape", () => {
    const result = parseDeliveryVerification({
      manifestNodeId: "art_1",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [
        { category: "source", path: "src/index.ts", required: true, status: "verified" },
        { category: "docs", path: "README.md", required: true, status: "missing" },
      ],
    });
    expect(result.rows).toEqual([
      { path: "src/index.ts", kind: "source", status: "passed" },
      { path: "README.md", kind: "docs", status: "failed" },
    ]);
    expect(result.summary).toEqual({ passed: 1, failed: 1, unverified: 0 });
    expect(result.problems).toEqual([]);
  });

  test("reads the delivery_status tool result envelope", () => {
    const result = parseDeliveryVerification({
      report: {
        manifestNodeId: "art_1",
        checkedAt: "2026-01-01T00:00:00.000Z",
        complete: true,
        items: [{ category: "source", path: "a.ts", required: true, status: "verified" }],
        failed: [],
      },
      blockers: null,
    });
    expect(result.rows).toEqual([{ path: "a.ts", kind: "source", status: "passed" }]);
  });

  test("reads a delivery_manifest artifact's embedded verification field", () => {
    const result = parseDeliveryVerification({
      descriptors: [],
      costForecast: null,
      costActual: null,
      costActualReason: null,
      verification: {
        items: [{ category: "tests", path: "spec.ts", required: false, status: "hash_mismatch", detail: "bytes differ" }],
      },
    });
    expect(result.rows).toEqual([{ path: "spec.ts", kind: "tests", status: "failed", note: "bytes differ" }]);
  });

  test("maps inaccessible to unverified, never to passed", () => {
    const result = parseDeliveryVerification({
      items: [{ category: "assets", path: "logo.png", required: true, status: "inaccessible", detail: "no remote fetcher" }],
    });
    expect(result.rows[0]?.status).toBe("unverified");
    expect(result.summary).toEqual({ passed: 0, failed: 0, unverified: 1 });
  });

  test("maps an unknown status to unverified and reports it", () => {
    const result = parseDeliveryVerification({ items: [{ path: "x.ts", status: "weird" }] });
    expect(result.rows[0]?.status).toBe("unverified");
    expect(result.problems.length).toBe(1);
  });

  test("treats a missing status the same way", () => {
    const result = parseDeliveryVerification({ items: [{ path: "x.ts" }] });
    expect(result.rows[0]?.status).toBe("unverified");
    expect(result.problems.length).toBe(1);
  });

  test("reports malformed input without throwing", () => {
    expect(parseDeliveryVerification(null).problems).toEqual(["verification is missing"]);
    expect(parseDeliveryVerification(undefined).problems).toEqual(["verification is missing"]);
    expect(parseDeliveryVerification("not an object").problems).toEqual(["verification could not be read"]);
    expect(parseDeliveryVerification({ items: "not an array" }).problems).toEqual(["verification could not be read"]);
    expect(parseDeliveryVerification(42).rows).toEqual([]);
  });

  test("skips an entry missing a path and reports it", () => {
    const result = parseDeliveryVerification({ items: [{ status: "verified" }] });
    expect(result.rows).toEqual([]);
    expect(result.problems).toEqual(['a verification entry is missing its path']);
  });

  test("accepts name in place of path", () => {
    const result = parseDeliveryVerification({ items: [{ name: "a.ts", status: "verified" }] });
    expect(result.rows[0]?.path).toBe("a.ts");
  });

  test("counts a mix of statuses", () => {
    const result = parseDeliveryVerification({
      items: [
        { path: "a.ts", status: "verified" },
        { path: "b.ts", status: "verified" },
        { path: "c.ts", status: "missing" },
        { path: "d.ts", status: "inaccessible" },
      ],
    });
    expect(result.summary).toEqual({ passed: 2, failed: 1, unverified: 1 });
  });
});
