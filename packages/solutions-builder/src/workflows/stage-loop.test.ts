import { describe, expect, test } from "bun:test";
import {
  ADMIT_STEP_ID,
  BUILD_STEP_ID,
  GATE_WAIT_STEP_ID,
  admitInput,
  gateIteration,
  EVIDENCE_ADMIT_STEP_ID,
  EVIDENCE_STEP_ID,
  approveSignal,
  evidenceGate,
  evidenceSignal,
  positionOfSignal,
  roundSignal,
  stageSignal,
} from "./stage-loop.js";
import type { Stage } from "../ledger.js";

const BUILD = 8 as Stage;

describe("evidence park", () => {
  test("evidenceSignal(8) is solutions-builder.stage.8.evidence", () => {
    expect(evidenceSignal(BUILD)).toBe("solutions-builder.stage.8.evidence");
  });

  test("accept maps to the evidence signal, not gate-8", () => {
    expect(stageSignal(BUILD, "build.accept_evidence").name).toBe(evidenceSignal(BUILD));
    expect(stageSignal(BUILD, "build.accept_evidence").name).not.toBe(approveSignal(BUILD));
    expect(stageSignal(BUILD, "build.accept_evidence").payload.command).toBe("build.accept_evidence");
  });

  test("fail maps to the evidence signal, not the round", () => {
    expect(stageSignal(BUILD, "build.fail").name).toBe(evidenceSignal(BUILD));
    expect(stageSignal(BUILD, "build.fail").name).not.toBe(roundSignal(BUILD));
    expect(stageSignal(BUILD, "build.fail").payload.command).toBe("build.fail");
  });

  test("start_attempt still lands on the round", () => {
    expect(stageSignal(BUILD, "build.start_attempt").name).toBe(roundSignal(BUILD));
  });

  test("evidenceGate waits after the build agent and admits through admitGate", () => {
    const steps = evidenceGate([BUILD_STEP_ID]) as Record<
      string,
      { kind?: string; name?: string; handler?: string; after?: string[] }
    >;
    const wait = steps[EVIDENCE_STEP_ID];
    const admit = steps[EVIDENCE_ADMIT_STEP_ID];
    expect(wait?.kind).toBe("awaitSignal");
    expect(wait?.name).toBe(evidenceSignal(BUILD));
    expect(wait?.after).toEqual([BUILD_STEP_ID]);
    expect(admit?.kind).toBe("action");
    expect(admit?.handler).toBe("admitGate");
    expect(admit?.after).toEqual([EVIDENCE_STEP_ID]);
  });

  test("a parked evidence signal still reads as the stage 8 round", () => {
    expect(positionOfSignal(BUILD, evidenceSignal(BUILD))).toEqual({ stage: BUILD, at: "round" });
  });

  test("the evidence admit reads the gate's stage and kind as literals, after the intent", () => {
    const steps = evidenceGate([BUILD_STEP_ID]) as Record<string, { input?: unknown }>;
    expect(steps[EVIDENCE_ADMIT_STEP_ID]?.input).toEqual(admitInput(EVIDENCE_STEP_ID, { stage: BUILD, gate: "evidence" }));
  });
});

describe("gate = wait + named signal", () => {
  test("AC4: the stage-9 (final) gate maps to its named signal", () => {
    const FINAL = 9 as Stage;
    expect(approveSignal(FINAL)).toBe("solutions-builder.stage.9.approve");
    for (const command of ["delivery.accept", "delivery.reject", "delivery.revise"] as const) {
      expect(stageSignal(FINAL, command).name).toBe(approveSignal(FINAL));
      expect(stageSignal(FINAL, command, "exhausted").name).toBe("solutions-builder.stage.9.approve-after-exhaustion");
    }
    expect(positionOfSignal(FINAL, approveSignal(FINAL))).toEqual({ stage: FINAL, at: "gate" });
  });

  test("a gate iteration is one wait step and one admit whose literals come last", () => {
    const steps = (gateIteration(5 as Stage, "gate", 2) as unknown as { steps: Record<string, Record<string, unknown>> }).steps;
    expect(steps[GATE_WAIT_STEP_ID]).toMatchObject({ kind: "awaitSignal", name: approveSignal(5 as Stage) });
    expect(steps[ADMIT_STEP_ID]).toMatchObject({ kind: "action", handler: "admitGate", after: [GATE_WAIT_STEP_ID] });
    const input = steps[ADMIT_STEP_ID]?.input as { merge: unknown[] };
    expect(input.merge.at(-1)).toEqual({ literal: { stage: 5, gate: "gate", quorum: 2 } });
    expect(input.merge).toContainEqual({ from: `steps.${GATE_WAIT_STEP_ID}.output` });
  });
});
