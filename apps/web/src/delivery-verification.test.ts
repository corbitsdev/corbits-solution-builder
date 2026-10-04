import { describe, expect, test } from "bun:test";
import { AGENT_REPORTED_NOTE, parseDeliveryVerification, parseDeliveryVerificationJson, verificationRecordUnreadable } from "./delivery-verification.ts";

describe("parseDeliveryVerification", () => {
  test("reads a report's items shape", () => {
    const result = parseDeliveryVerification({
      manifestNodeId: "art_1",
      checkedAt: "2026-01-01T00:00:00.000Z",
      items: [
        { category: "source", path: "src/index.ts", required: true, status: "verified" },
        { category: "docs", path: "README.md", required: true, status: "missing" },
      ],
    });
    expect(result.rows).toEqual([
      { path: "src/index.ts", kind: "source", status: "unverified", note: AGENT_REPORTED_NOTE },
      { path: "README.md", kind: "docs", status: "failed" },
    ]);
    expect(result.summary).toEqual({ passed: 0, failed: 1, unverified: 1 });
    expect(result.problems).toEqual([]);
  });

  // #129: `publish_workspace` re-hashes the archive and probes each target
  // itself, and marks what it checked `checkedBy: "tool"`. That, and only
  // that, is a pass.
  test("a tool-checked verified item is a pass, and a tool-checked failure is a failure", () => {
    const result = parseDeliveryVerification({
      verification: {
        checkedBy: "tool",
        items: [
          { category: "source", path: "src/index.ts", required: true, status: "verified", checkedBy: "tool" },
          { category: "source", path: "src/gone.ts", required: true, status: "missing", checkedBy: "tool", detail: "not in the archive" },
          { category: "receipts", path: "target:web", required: true, status: "failed", checkedBy: "tool", detail: "port 3000 never accepted a connection within 15000ms." },
          { category: "receipts", path: "target:cli", required: true, status: "inaccessible", checkedBy: "tool", detail: "no cli verifier exists in this repo" },
        ],
      },
    });
    expect(result.rows.map((row) => [row.path, row.status])).toEqual([
      ["src/index.ts", "passed"],
      ["src/gone.ts", "failed"],
      ["target:web", "failed"],
      ["target:cli", "unverified"],
    ]);
    expect(result.rows[0]?.note).toBeUndefined();
    expect(result.rows[2]?.note).toContain("never accepted a connection");
    expect(result.summary).toEqual({ passed: 1, failed: 2, unverified: 1 });
    expect(result.problems).toEqual([]);
  });

  test("a claim of tool provenance must be on the item itself, and must say tool", () => {
    const result = parseDeliveryVerification({
      verification: {
        checkedBy: "tool",
        items: [
          { category: "source", path: "a.ts", required: true, status: "verified" },
          { category: "source", path: "b.ts", required: true, status: "verified", checkedBy: "agent" },
          { category: "source", path: "c.ts", required: true, status: "passed", checkedBy: "model" },
        ],
      },
    });
    expect(result.rows.map((row) => row.status)).toEqual(["unverified", "unverified", "unverified"]);
    expect(result.rows.every((row) => row.note?.startsWith(AGENT_REPORTED_NOTE))).toBe(true);
  });

  // #32: the agent scores items from the text it was handed; no code checks
  // the files, so its "verified" is a claim, never a pass.
  test("an agent-reported verified item never renders as passed, and says why", () => {
    const result = parseDeliveryVerification({
      items: [
        { category: "source", path: "a.ts", required: true, status: "verified" },
        { category: "source", path: "b.ts", required: true, status: "verified", detail: "hash matches the manifest" },
        { category: "source", path: "c.ts", required: true, status: "passed" },
      ],
    });
    expect(result.rows.map((row) => row.status)).toEqual(["unverified", "unverified", "unverified"]);
    expect(result.rows[0]?.note).toBe(AGENT_REPORTED_NOTE);
    expect(result.rows[1]?.note).toBe(`${AGENT_REPORTED_NOTE}: hash matches the manifest`);
    expect(result.rows[2]?.note).toBe(AGENT_REPORTED_NOTE);
    expect(result.summary).toEqual({ passed: 0, failed: 0, unverified: 3 });
    expect(result.problems).toEqual([]);
  });

  test("reads a report envelope", () => {
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
    expect(result.rows).toEqual([{ path: "a.ts", kind: "source", status: "unverified", note: AGENT_REPORTED_NOTE }]);
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
    expect(result.summary).toEqual({ passed: 0, failed: 1, unverified: 3 });
  });
});

describe("parseDeliveryVerificationJson", () => {
  test("never throws on empty or non-JSON content", () => {
    expect(() => parseDeliveryVerificationJson("")).not.toThrow();
    expect(() => parseDeliveryVerificationJson("{")).not.toThrow();
    expect(() => parseDeliveryVerificationJson("not json")).not.toThrow();
    expect(parseDeliveryVerificationJson("").problems).toEqual(["verification is missing"]);
    expect(parseDeliveryVerificationJson("{").problems).toEqual(["verification could not be read"]);
    expect(verificationRecordUnreadable(parseDeliveryVerificationJson(""))).toBe(true);
    expect(verificationRecordUnreadable(parseDeliveryVerificationJson("{"))).toBe(true);
  });

  test("parses a JSON artifact body", () => {
    const result = parseDeliveryVerificationJson(
      JSON.stringify({ items: [{ path: "a.ts", status: "verified", checkedBy: "tool" }] }),
    );
    expect(result.rows).toEqual([{ path: "a.ts", status: "passed" }]);
    expect(verificationRecordUnreadable(result)).toBe(false);
  });

  test("an empty checklist with no problems is not unreadable", () => {
    expect(verificationRecordUnreadable(parseDeliveryVerification({ items: [] }))).toBe(false);
  });
});
