import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("the host relays rounds and nothing else", () => {
  test("gate-delivery relays stage.draft only; a gate command is refused", async () => {
    const { ROUND_COMMAND, deliverRound } = await import("./gate-delivery.js");
    expect(ROUND_COMMAND).toBe("stage.draft");
    await expect(
      deliverRound(
        { type: "stage.approve", actor: { principalId: "p", displayName: "P" }, projectId: "tnt_1", idempotencyKey: "k", correlationId: "c", payload: {} },
        3,
      ),
    ).rejects.toThrow(/decided on the run/);
    const source = await read("./gate-delivery.ts");
    expect(source).not.toContain("GATE_COMMANDS");
    expect(source).not.toContain("alignRunWithLedger");
    expect(source).not.toContain("actorAuthorities");
  });

  test("command-dispatch has no submitAndApprove, no gate branch, no host-built run context in a signal, and relays no draft round any more", async () => {
    const source = await read("./command-dispatch.ts");
    expect(source).not.toContain("submitAndApprove");
    expect(source).not.toContain("runGateSideEffects");
    expect(source).not.toMatch(/payload: \{ \.\.\.input\.payload, command: input\.type, run, context \}/);
    // `stage.draft` is client-delivered now (`apps/web/src/run-signal.ts`'s
    // `deliverDraft`), the same way a gate decision is: the host's own
    // `deliverRound` has no caller left here.
    expect(source).not.toContain("deliverRound");
    expect(source).not.toContain('"stage.draft"');
    const lifecycle = await read("./lifecycle-run.ts");
    expect(lifecycle).not.toContain("alignRunWithLedger");
    expect(lifecycle).not.toContain("recordGateFromSignal");
  });
});

describe("AC5: authority is the hub's signal grant", () => {
  test("the vendored signal route authorizes signal:<name> (else manage) and 403s without it", async () => {
    const route = await Bun.file(new URL("../../../vendor/interchange/packages/hub-api/src/routes/workflows.ts", import.meta.url)).text();
    expect(route).toContain("`signal:${args.signalName}`");
    expect(route).toContain("if (named.effect === \"allow\") return true;");
    expect(route).toContain("return c.json(forbidden(), 403);");
    expect(route).toContain("stampSignalPrincipalId(body.payload, principal.id)");
  });

  test("the /hub mount forwards the browser's own cookies and never swaps in the owner session", async () => {
    const server = await read("./server.ts");
    const mount = server.slice(server.indexOf('app.all("/hub/*"'), server.indexOf("const server = Bun.serve("));
    expect(mount).toContain("hubProxyHeaders(context.req.raw.headers)");
    expect(mount).not.toContain("currentSession()");
    expect(mount).not.toContain("localActor");
  });

  test("the host has no route a gate decision could take instead", async () => {
    const source = await read("./api-decisions.ts");
    expect(source).not.toContain('"/projects/:projectId/submit"');
    expect(source).not.toContain('"/projects/:projectId/decide"');
    expect(source).not.toContain("abortBuildAttempt");
    const { HOST_EFFECT_COMMANDS } = await import("./api-decisions.js");
    for (const gate of ["stage.submit", "stage.approve", "cost.approve", "stage.reject", "stage.revise", "audience.decide", "delivery.accept", "build.cancel", "build.interrupt"]) {
      expect(HOST_EFFECT_COMMANDS).not.toContain(gate);
    }
  });
});
