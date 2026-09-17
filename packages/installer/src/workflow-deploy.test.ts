import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    expect(loops).toContain('["evidence"]');
  });

  test("stillOpen reads the evidence command, not the round start_attempt", async () => {
    const files = renderLifecycleSource();
    const loops = files["packages/lifecycle/loops.js"]!;
    // Bun does not evaluate `data:text/javascript` as ESM (named exports vanish),
    // so the generated loops module is loaded from a file the way the sidecar would.
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-loops-"));
    const path = join(dir, "loops.js");
    await writeFile(path, loops);
    try {
      const mod = (await import(pathToFileURL(path).href)) as {
        stillOpen: (output: Record<string, unknown>) => boolean;
        carryRound: (output: Record<string, unknown>, carry: unknown) => unknown;
      };
      const start = { round: { command: "build.start_attempt" } };
      expect(mod.stillOpen(start)).toBe(true);
      expect(mod.stillOpen({ ...start, evidence: { command: "build.fail" } })).toBe(true);
      expect(mod.stillOpen({ ...start, evidence: { command: "build.accept_evidence" } })).toBe(false);
      const carried = { command: "build.accept_evidence" };
      expect(mod.carryRound({ ...start, evidence: carried }, start.round)).toEqual(carried);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("closes the app member for admit, guard, and project-state", () => {
    const files = renderLifecycleSource();
    expect(files["packages/solutions-builder-app/src/admit.ts"]).toContain("export async function admitGate");
    expect(files["packages/solutions-builder-app/src/guard.ts"]).toContain("export function evaluate");
    expect(files["packages/solutions-builder-app/src/project-state.ts"]).toContain("export function projectState");
  });
});
