import { describe, expect, test } from "bun:test";

describe("runGateSideEffects", () => {
  test("accept and fail are delivered as gate commands, not left on gate-8's mapping", async () => {
    const { GATE_COMMANDS } = await import("./gate-delivery.js");
    expect(GATE_COMMANDS).toContain("build.accept_evidence");
    expect(GATE_COMMANDS).toContain("build.fail");
  });

  test("a delivered gate records a ledger turn without going through api-decisions", async () => {
    const source = await Bun.file(new URL("./gate-delivery.ts", import.meta.url)).text();
    expect(source).toContain("recordGateFromSignal");
    expect(source).toContain("crypto.randomUUID()");
    expect(source).not.toMatch(/from ["']\.\/api-decisions/);
    expect(source).not.toMatch(/from ["']\.\/api\.js["']/);
    const lifecycle = await Bun.file(new URL("./lifecycle-run.ts", import.meta.url)).text();
    expect(lifecycle).toContain("recordGateFromSignal");
  });
});

describe("command-dispatch admit order", () => {
  test("GATE_COMMANDS deliver first; evaluate is not the admit authority; host never writes RunDraft", async () => {
    const source = await Bun.file(new URL("./command-dispatch.ts", import.meta.url)).text();
    const deliver = source.indexOf("runGateSideEffects(");
    const verdict = source.indexOf("evaluate(input.type, run, context)");
    const refuse = source.indexOf('if (!verdict.ok && delivery !== "delivered")');
    expect(deliver).toBeGreaterThan(0);
    expect(verdict).toBeGreaterThan(deliver);
    expect(refuse).toBeGreaterThan(verdict);
    expect(source.search(/new RunDraft\s*\(/)).toBe(-1);
    const runsSource = await Bun.file(new URL("./runs.ts", import.meta.url)).text();
    expect(runsSource.search(/\bclass RunDraft\b/)).toBe(-1);
    expect(source).toContain("admitGate` is the admit authority");
    expect(source).toContain('if (delivery !== "delivered")');
    expect(source).toContain("await recordCommand({");
  });
});

describe("host command routes still exist", () => {
  test("command, submit and decide routes are still registered", async () => {
    const source = await Bun.file(new URL("./api-decisions.ts", import.meta.url)).text();
    expect(source).toContain('api.post("/projects/:projectId/commands/:command"');
    expect(source).toContain('api.post("/projects/:projectId/submit"');
    expect(source).toContain('api.post("/projects/:projectId/decide"');
  });

  test("the host delivery reverify/judge route is gone", async () => {
    const source = await Bun.file(new URL("./api-decisions.ts", import.meta.url)).text();
    expect(source).not.toContain('api.post("/projects/:projectId/delivery/reverify"');
    expect(source).not.toContain("reverifyDelivery");
    const delivery = await Bun.file(new URL("./delivery.ts", import.meta.url)).text();
    expect(delivery).not.toContain("export async function reverifyDelivery");
  });
});
