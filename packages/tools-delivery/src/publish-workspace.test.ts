import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishWorkspace, TOOL_NAME, BUNDLE_MEDIA_TYPE } from "./publish-workspace.js";

const controller = new AbortController();
const dirs: string[] = [];

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "publish-workspace-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("publish_workspace", () => {
  test("tars the tool's cwd into a base64 data URI", async () => {
    const cwd = await workspaceWith({ "src/index.ts": "export const x = 1;\n" });
    const bundle = publishWorkspace({ toolCwd: cwd } as never);
    const result = await bundle.run({ id: "1", name: TOOL_NAME, arguments: { fileName: "app.tar.gz" } }, controller.signal);
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content as string) as {
      fileName: string;
      mediaType: string;
      sizeBytes: number;
      dataUri: string;
    };
    expect(parsed.fileName).toBe("app.tar.gz");
    expect(parsed.mediaType).toBe(BUNDLE_MEDIA_TYPE);
    expect(parsed.sizeBytes).toBeGreaterThan(0);
    expect(parsed.dataUri.startsWith(`data:${BUNDLE_MEDIA_TYPE};base64,`)).toBe(true);
  });

  test("excludes node_modules by default", async () => {
    const cwd = await workspaceWith({
      "src/index.ts": "export const x = 1;\n",
      "node_modules/dep/index.js": "module.exports = {};\n",
    });
    const bundle = publishWorkspace({ toolCwd: cwd } as never);
    const result = await bundle.run({ id: "2", name: TOOL_NAME, arguments: {} }, controller.signal);
    const parsed = JSON.parse(result.content as string) as { dataUri: string };
    const base64 = parsed.dataUri.slice(parsed.dataUri.indexOf(",") + 1);
    const archivePath = join(await workspaceWith({}), "out.tar.gz");
    await writeFile(archivePath, Buffer.from(base64, "base64"));
    const listing = await new Promise<string>((resolve, reject) => {
      const child = spawn("tar", ["-tzf", archivePath]);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tar -tzf exited ${String(code)}`))));
    });
    expect(listing).toContain("src/index.ts");
    expect(listing).not.toContain("node_modules");
  });

  test("the tool's own id is namespaced under @solutions-builder/tools-delivery", () => {
    expect(publishWorkspace.id).toBe("@solutions-builder/tools-delivery/publish-workspace");
  });
});
