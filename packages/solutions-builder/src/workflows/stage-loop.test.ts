import { describe, expect, test } from "bun:test";
import {
  agentStepIds,
  approveChain,
  approveSignal,
  chatBody,
  CHAT_STEP_ID,
  DELIVERY_STAGE,
  DELIVERY_STEP_ID,
  EVIDENCE_STEP_ID,
  evidenceSignal,
  FREEZE_STEP_ID,
  freezeSignal,
  gateStepId,
  NONE_STEP_ID,
  packageStepId,
  ROUTE_STEP_ID,
  routerStepId,
  stageEnds,
  stageOfSignal,
  stageOfStepId,
  UNROUTED_STEP_ID,
} from "./stage-loop.js";
import type { Stage } from "../ledger.js";

describe("chatBody", () => {
  test("routes to route, then a binary is-N chain over trigger.payload", () => {
    const body = chatBody() as unknown as { id: string; steps: Record<string, Record<string, unknown>> };
    expect(body.id).toBe("solutions-builder.stage.chat");
    expect(body.steps[ROUTE_STEP_ID]).toMatchObject({ kind: "action", handler: "routeMessage" });
    expect(body.steps[ROUTE_STEP_ID]?.input).toEqual({ from: "trigger.payload" });
  });

  test("with no agent steps, every is-N lands on none", () => {
    const body = chatBody() as unknown as { steps: Record<string, Record<string, unknown>> };
    for (const stage of [1, 2, 3, 4, 5, 6, 7, 8] as Stage[]) {
      const isId = routerStepId(stage);
      expect(body.steps[isId]).toMatchObject({ kind: "gate", then: NONE_STEP_ID });
      expect(body.steps[isId]?.when).toEqual({ from: `steps.${ROUTE_STEP_ID}.output.at.${stage}` });
    }
    expect(body.steps[NONE_STEP_ID]).toMatchObject({ kind: "escalation", to: NONE_STEP_ID, after: [routerStepId(8 as Stage)] });
  });

  test("is-1 follows route; is-N follows is-(N-1)", () => {
    const body = chatBody() as unknown as { steps: Record<string, Record<string, unknown>> };
    expect(body.steps[routerStepId(1 as Stage)]?.after).toEqual([ROUTE_STEP_ID]);
    expect(body.steps[routerStepId(2 as Stage)]?.after).toEqual([routerStepId(1 as Stage)]);
    expect(body.steps[routerStepId(8 as Stage)]?.after).toEqual([routerStepId(7 as Stage)]);
  });

  test("is-N's else chains forward; is-8's else is its own terminal, distinct from its then", () => {
    const body = chatBody() as unknown as { steps: Record<string, Record<string, unknown>> };
    expect(body.steps[routerStepId(1 as Stage)]?.else).toBe(routerStepId(2 as Stage));
    expect(body.steps[routerStepId(8 as Stage)]?.else).toBe(UNROUTED_STEP_ID);
    expect(body.steps[routerStepId(8 as Stage)]?.then).not.toBe(body.steps[routerStepId(8 as Stage)]?.else);
  });

  test("a stage with agent steps routes is-N to the first of them", () => {
    const body = chatBody({
      1: { "draft-1": { kind: "step" } },
    }) as unknown as { steps: Record<string, Record<string, unknown>> };
    expect(body.steps[routerStepId(1 as Stage)]).toMatchObject({ then: "draft-1" });
    expect(body.steps["draft-1"]).toEqual({ kind: "step" });
  });
});

describe("agentStepIds", () => {
  test("stage 1 drafts then evaluates", () => {
    expect(agentStepIds(1 as Stage, 0)).toEqual(["draft-1", "evaluate-1"]);
  });

  test("stages 2, 3, 4, 7 are a single draft", () => {
    for (const stage of [2, 3, 4, 7] as Stage[]) {
      expect(agentStepIds(stage, 0)).toEqual([`draft-${stage}`]);
    }
  });

  test("stage 5 packages one step per audience", () => {
    expect(agentStepIds(5 as Stage, 0)).toEqual([]);
    expect(agentStepIds(5 as Stage, 3)).toEqual([packageStepId(0), packageStepId(1), packageStepId(2)]);
  });

  test("stage 6 is requirements, draft, then a review per panel principal", () => {
    const ids = agentStepIds(6 as Stage, 0);
    expect(ids[0]).toBe("requirements-6");
    expect(ids[1]).toBe("draft-6");
    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids.slice(2)) expect(id.startsWith("review-6-")).toBe(true);
  });

  test("stage 8 is the build step", () => {
    expect(agentStepIds(8 as Stage, 0)).toEqual(["build-8"]);
  });

  test("stage 9 contributes no chat-body step: delivery-check is top-level", () => {
    expect(agentStepIds(9 as Stage, 0)).toEqual([]);
  });
});

describe("approveChain", () => {
  test("gate-1..gate-7 chain in order, all awaiting approveSignal", () => {
    const steps = approveChain() as Record<string, { kind?: string; name?: string; after?: string[] }>;
    expect(steps[gateStepId(1 as Stage)]).toMatchObject({ kind: "awaitSignal", name: approveSignal(1 as Stage) });
    expect(steps[gateStepId(1 as Stage)]?.after).toBeUndefined();
    for (const stage of [2, 3, 4, 5, 6, 7] as Stage[]) {
      expect(steps[gateStepId(stage)]).toMatchObject({
        kind: "awaitSignal",
        name: approveSignal(stage),
        after: [gateStepId((stage - 1) as Stage)],
      });
    }
  });

  test("gate-7 -> freeze -> evidence -> gate-8", () => {
    const steps = approveChain() as Record<string, { kind?: string; name?: string; after?: string[] }>;
    expect(steps[FREEZE_STEP_ID]).toMatchObject({ kind: "awaitSignal", name: freezeSignal(), after: [gateStepId(7 as Stage)] });
    expect(steps[EVIDENCE_STEP_ID]).toMatchObject({
      kind: "awaitSignal",
      name: evidenceSignal(8 as Stage),
      after: [FREEZE_STEP_ID],
    });
    expect(steps[gateStepId(8 as Stage)]).toMatchObject({
      kind: "awaitSignal",
      name: approveSignal(8 as Stage),
      after: [EVIDENCE_STEP_ID],
    });
  });
});

describe("position", () => {
  test("stageOfSignal reads the stage out of a signal this module issued", () => {
    expect(stageOfSignal(approveSignal(3 as Stage))).toBe(3);
    expect(stageOfSignal(evidenceSignal(8 as Stage))).toBe(8);
    expect(stageOfSignal("something.else")).toBeNull();
  });

  test("stageOfStepId resolves gate-N, freeze, evidence and delivery-check", () => {
    expect(stageOfStepId(gateStepId(4 as Stage))).toBe(4);
    expect(stageOfStepId(FREEZE_STEP_ID)).toBe(7);
    expect(stageOfStepId(EVIDENCE_STEP_ID)).toBe(8);
    expect(stageOfStepId(DELIVERY_STEP_ID)).toBe(DELIVERY_STAGE);
    expect(stageOfStepId(CHAT_STEP_ID)).toBeNull();
  });

  test("stageEnds: gate-N for every stage but 7, which ends at freeze", () => {
    expect(stageEnds(3 as Stage)).toEqual([gateStepId(3 as Stage)]);
    expect(stageEnds(7 as Stage)).toEqual([FREEZE_STEP_ID]);
  });
});
