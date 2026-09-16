import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedBuildWorkspace } from "./build-workspace.js";

/**
 * The seed is what makes "built on Interchange" buildable: a fresh
 * workspace must resolve the platform packages from the npm registry
 * (preferred path (a) — `bun add @intx/workflow@0.3.0 @intx/agent
 * @intx/tools-posix`; `@intx/workflow` 0.3.0 on the `latest` tag per
 * `using-interchange.md`, the other two 0.3.0 verified against the live
 * registry) with nothing else
 * planted. The `vendor/*` workspaces globs stay as the offline fallback
 * (b), used only when the registry is blocked.
 */
describe("seedBuildWorkspace platform dependencies", () => {
  test(
    "a fresh seed installs from the registry and resolves @intx/agent",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "build-workspace-test-"));
      try {
        await seedBuildWorkspace(
          dir,
          { title: "Seed check", plan: "plan", requirements: "reqs" },
          { fresh: true },
        );

        const manifest = JSON.parse(
          await Bun.file(join(dir, "package.json")).text(),
        ) as { dependencies?: Record<string, string> };
        expect(manifest.dependencies?.["@intx/workflow"]).toBe("0.3.0");
        expect(manifest.dependencies?.["@intx/agent"]).toBe("0.3.0");
        expect(manifest.dependencies?.["@intx/tools-posix"]).toBe("0.3.0");

        const install = Bun.spawnSync(["bun", "install"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(install.success).toBe(true);

        await Bun.write(
          join(dir, "apps", "platform-check.ts"),
          [
            `import { defineAgent } from "@intx/agent";`,
            `import { defineWorkflow } from "@intx/workflow";`,
            `import { posix } from "@intx/tools-posix/sidecar-bundle";`,
            `export const agentRef = defineAgent;`,
            `export const workflowRef = defineWorkflow;`,
            `export const posixRef = posix;`,
            ``,
          ].join("\n"),
        );
        const typecheck = Bun.spawnSync(["bun", "run", "typecheck"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const typecheckOutput = `${typecheck.stdout.toString()}${typecheck.stderr.toString()}`;
        expect(typecheckOutput).not.toContain("error TS");
        expect(typecheck.success).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
