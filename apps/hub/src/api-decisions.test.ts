import { describe, expect, test } from "bun:test";
import { LEDGER } from "@solutions-builder/app/ledger";
import { HOST_EFFECT_COMMANDS } from "./api-decisions.js";

describe("AC3: the host holds no decision a body field could stale-check", () => {
  test("every command out of a stage gate is off the host; only effects remain", () => {
    const gates = LEDGER.filter((row) => row.from?.kind === "stage" && row.from.state !== "in_progress").map((row) => row.command);
    for (const gate of gates) {
      if (gate === "stage.select_route" || gate === "stage.retry" || gate === "project.archive") continue;
      expect(HOST_EFFECT_COMMANDS).not.toContain(gate);
    }
    expect(HOST_EFFECT_COMMANDS).not.toContain("build.freeze");
  });

  test("the route reads no expectedRevision or idempotencyKey for a decision", async () => {
    const source = await Bun.file(new URL("./api-decisions.ts", import.meta.url)).text();
    expect(source).not.toContain("expectedRevision");
    expect(source).not.toContain("idempotencyKey");
    expect(source).not.toContain("SoloDecidePayload");
    const domain = await Bun.file(new URL("./domain.ts", import.meta.url)).text();
    for (const gone of ["SoloDecidePayload", "StageApprovePayload", "AudienceDecidePayload", "CostApprovePayload", "RoutePayload", "DeliveryDecisionPayload"]) {
      expect(domain).not.toContain(gone);
    }
  });
});
