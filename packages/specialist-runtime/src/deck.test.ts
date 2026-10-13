import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// The live failure was "Slides for …: Error: nodebuffer is not supported by
// this platform" on export: `renderDeck` asked pptxgenjs/JSZip for a
// `nodebuffer`, which throws wherever Node's `Buffer` is unavailable (the
// browser export path, the workflow-child sandbox). The fixture renders in a
// fresh process with `Buffer` removed before any import, the way those
// runtimes look to JSZip at module load.
describe("renderDeck without Node's Buffer", () => {
  test("a text-only deck and one with a cover picture both render as zips", () => {
    const fixture = fileURLToPath(new URL("./deck-nobuffer-fixture.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
    const stderr = result.stderr.toString();
    expect(`${stderr}\n${result.stdout.toString()}`).toContain("OK ");
    expect(result.exitCode).toBe(0);
  });
});
