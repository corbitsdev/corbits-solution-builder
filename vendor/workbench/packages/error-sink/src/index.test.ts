import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureSync, resetSync } from "@intx/log";
// `LogRecord` isn't part of `@intx/log`'s narrow re-export surface (only
// symbols an `@intx/*` consumer actually needs are re-exported there); its
// own README says to reach into `@logtape/logtape` directly for anything
// else, rather than widen that surface for a type this test alone needs.
import type { LogRecord } from "@logtape/logtape";
import { reportError } from "./index";

let records: LogRecord[];

function installCapturingSink(): void {
  records = [];
  configureSync({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record);
      },
    },
    loggers: [
      { category: ["errors"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

beforeEach(() => installCapturingSink());
afterEach(() => resetSync());

describe("reportError context capture", () => {
  test("carries operation, tenant/room/agent ids, and a quotable refId", () => {
    const refId = reportError(new Error("boom"), {
      operation: "resolveFallbackWorkbenchId",
      tenantId: "tenant_1",
      roomId: "room_1",
      agentId: "agent_1",
    });

    expect(records).toHaveLength(1);
    const properties = records[0]?.properties as Record<string, unknown>;
    expect(properties.operation).toBe("resolveFallbackWorkbenchId");
    expect(properties.tenantId).toBe("tenant_1");
    expect(properties.roomId).toBe("room_1");
    expect(properties.agentId).toBe("agent_1");
    expect(properties.refId).toBe(refId);
    expect(typeof refId).toBe("string");
    expect(refId.length).toBeGreaterThan(0);
  });

  test("mints a refId when the caller doesn't supply one, and reuses a supplied one", () => {
    const minted = reportError(new Error("boom"), { operation: "op" });
    expect(minted.length).toBeGreaterThan(0);

    const reused = reportError(new Error("boom"), {
      operation: "op",
      refId: "support-quotable-id",
    });
    expect(reused).toBe("support-quotable-id");
  });

  test("carries redacted extra context", () => {
    reportError(new Error("boom"), {
      operation: "op",
      extra: { apiKey: "sk-abcdefgh1234", userId: "user_1" },
    });

    const properties = records[0]?.properties as Record<string, unknown>;
    expect(properties.extra).toEqual({
      apiKey: "[redacted]",
      userId: "user_1",
    });
  });

  test('degrades an invalid context to operation "unknown" instead of throwing', () => {
    // @ts-expect-error -- deliberately malformed to prove the degrade path
    const refId = reportError(new Error("boom"), {});
    expect(typeof refId).toBe("string");
    const properties = records[0]?.properties as Record<string, unknown>;
    expect(properties.operation).toBe("unknown");
  });

  test("redacts a secret in the error message before it reaches the sink", () => {
    reportError(new Error("rejected Bearer abc.def.ghi"), { operation: "op" });
    const loggedError = records[0]?.message;
    expect(String(loggedError)).not.toContain("abc.def.ghi");
  });

  test("preserves the error's cause chain, redacted", () => {
    const inner = new Error("rejected Bearer abc.def.ghi");
    const outer = new Error("wrapped failure", { cause: inner });
    reportError(outer, { operation: "op" });

    const properties = records[0]?.properties as Record<string, unknown>;
    const loggedError = properties.error as Error;
    expect(loggedError.cause).toBeInstanceOf(Error);
    const cause = loggedError.cause as Error;
    expect(cause.message).not.toContain("abc.def.ghi");
    expect(cause.message).toContain("[redacted]");
  });

  test("caps a cyclic cause chain instead of recursing forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;

    expect(() => reportError(b, { operation: "op" })).not.toThrow();
  });
});

describe("reportError never throws", () => {
  test("survives a sink that throws", () => {
    configureSync({
      reset: true,
      sinks: {
        broken: () => {
          throw new Error("sink exploded");
        },
      },
      loggers: [
        { category: ["errors"], sinks: ["broken"], lowestLevel: "debug" },
        { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
      ],
    });

    expect(() =>
      reportError(new Error("boom"), { operation: "op" }),
    ).not.toThrow();
  });

  test("survives a non-Error thrown value", () => {
    expect(() =>
      reportError("plain string failure", { operation: "op" }),
    ).not.toThrow();
    expect(() => reportError(undefined, { operation: "op" })).not.toThrow();
  });
});
