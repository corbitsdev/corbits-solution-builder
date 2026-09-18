import { describe, expect, test } from "bun:test";
import { processAlive, retireDeadSidecars } from "./retire-dead-sidecars.js";

describe("processAlive", () => {
  test("this process's pid is alive", () => {
    expect(processAlive(`alloc:1:${process.pid}`)).toBe(true);
  });

  test("a missing or non-integer ref is dead", () => {
    expect(processAlive(undefined)).toBe(false);
    expect(processAlive("alloc:1:nope")).toBe(false);
    expect(processAlive("alloc:1:0")).toBe(false);
  });
});

describe("retireDeadSidecars", () => {
  test("marks this fingerprint's dead allocation lost and leaves the rest", async () => {
    const lost: string[] = [];
    await retireDeadSidecars(
      {
        listActive: async () => [
          {
            id: "dead",
            status: "allocated",
            generation: 2,
            provisionerBindingFingerprint: "here",
            externalRef: "dead:2:99999999",
          },
          {
            id: "live",
            status: "allocated",
            generation: 1,
            provisionerBindingFingerprint: "here",
            externalRef: `live:1:${process.pid}`,
          },
          {
            id: "other",
            status: "allocated",
            generation: 1,
            provisionerBindingFingerprint: "elsewhere",
            externalRef: "other:1:99999999",
          },
          {
            id: "released",
            status: "released",
            generation: 1,
            provisionerBindingFingerprint: "here",
            externalRef: "released:1:99999999",
          },
        ],
        markConnectionLost: async (args: { allocationId: string }) => {
          lost.push(args.allocationId);
        },
      },
      "here",
    );
    expect(lost).toEqual(["dead"]);
  });
});
