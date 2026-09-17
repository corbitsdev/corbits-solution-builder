import { describe, expect, test } from "bun:test";
import {
  BUILD_STEP_ID,
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
});
