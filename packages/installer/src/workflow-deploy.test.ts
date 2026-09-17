import { describe, expect, test } from "bun:test";
import { renderLifecycleSource } from "./workflow-deploy.js";

describe("renderLifecycleSource admit gate", () => {
  test("declares interchange.actions admitGate and gateRefused in loops", () => {
    const files = renderLifecycleSource();
    const member = JSON.parse(files["packages/lifecycle/package.json"]!) as {
      interchange: { actions?: string; loops?: string };
    };
    expect(member.interchange.actions).toBe("./actions.js");
    expect(member.interchange.loops).toBe("./loops.js");
    expect(files["packages/lifecycle/actions.js"]).toContain("admitGate");
    expect(files["packages/lifecycle/actions.js"]).toContain("@solutions-builder/app/admit");
    const loops = files["packages/lifecycle/loops.js"]!;
    expect(loops).toContain("export function gateRefused");
    expect(loops).toContain("export function carryGate");
    expect(loops).toContain("admit.refused === true");
  });

  test("closes the app member for admit, guard, and project-state", () => {
    const files = renderLifecycleSource();
    expect(files["packages/solutions-builder-app/src/admit.ts"]).toContain("export async function admitGate");
    expect(files["packages/solutions-builder-app/src/guard.ts"]).toContain("export function evaluate");
    expect(files["packages/solutions-builder-app/src/project-state.ts"]).toContain("export function projectState");
  });
});
