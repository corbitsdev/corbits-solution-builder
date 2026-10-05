import { beforeEach, describe, expect, test } from "bun:test";
import { beginRequest, endRequest, inFlightRequests, observeTick, resetRequestWatch, resourceLine } from "./request-watch.ts";

describe("request watch", () => {
  beforeEach(() => resetRequestWatch());

  test("a fast request says nothing; a slow one is said with its duration, status and company", () => {
    const lines: string[] = [];
    const fast = beginRequest("GET", "/api/status", 1_000);
    endRequest(fast, 200, (line) => lines.push(line), 1_500);
    expect(lines).toEqual([]);
    const slow = beginRequest("GET", "/api/tenants/t/workflows/d/runs/r/events", 2_000);
    beginRequest("POST", "/api/projects/p/build/attempts", 2_500);
    endRequest(slow, 200, (line) => lines.push(line), 14_300);
    expect(lines).toEqual(["Slow request: GET /api/tenants/t/workflows/d/runs/r/events took 12.3s (200); 1 other request in flight"]);
    expect(inFlightRequests(3_000)).toEqual([{ method: "POST", path: "/api/projects/p/build/attempts", ageMs: 500 }]);
  });

  test("the resource line is one greppable shape, naming the oldest request in flight", () => {
    expect(
      resourceLine({ rssBytes: 3_684_080 * 1024, heapUsedBytes: 512 * 1024 * 1024, lagMs: 4_200, inFlight: [{ method: "GET", path: "/api/me", ageMs: 9_800 }, { method: "GET", path: "/api/x", ageMs: 100 }] }),
    ).toBe("Host resources: rss 3598 MB, heap 512 MB, loop lag 4200ms; 2 requests in flight; oldest GET /api/me for 9.8s");
    expect(resourceLine({ rssBytes: 0, heapUsedBytes: 0, lagMs: 0, inFlight: [] })).toBe("Host resources: rss 0 MB, heap 0 MB, loop lag 0ms; 0 requests in flight");
  });

  test("a stall is said at once with what was in flight; the resource line goes out once a minute", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const usage = () => ({ rss: 100 * 1024 * 1024, heapUsed: 50 * 1024 * 1024 });
    beginRequest("GET", "/api/slow", 0);
    observeTick(50, log, 5_000, usage);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Host resources: rss 100 MB, heap 50 MB, loop lag 50ms; 1 request in flight; oldest GET \/api\/slow for 5\.0s$/);
    observeTick(50, log, 10_000, usage);
    expect(lines).toHaveLength(1);
    observeTick(4_200, log, 15_000, usage);
    expect(lines[1]).toBe("Event loop stalled for 4.2s; in flight: GET /api/slow (15.0s)");
    observeTick(10, log, 65_000, usage);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^Host resources:/);
  });
});
