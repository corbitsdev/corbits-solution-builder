import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The file the process provisioner spawns a sidecar from. `vendor:build`
 * bundles the sidecar app into `dist/index.js` (#194) so a spawn loads one
 * module instead of resolving and transpiling the `@intx/*` graph; a
 * checkout without the bundle runs the TypeScript entry as before, and says
 * so once, naming the path, so a slow placement is never a mystery.
 */
export function sidecarEntry(
  sidecarDir: string,
  report: (line: string) => void = (line) => console.log(line),
  exists: (path: string) => boolean = existsSync,
): string {
  const bundle = join(sidecarDir, "dist", "index.js");
  const source = join(sidecarDir, "src", "index.ts");
  if (exists(bundle)) return bundle;
  report(`Sidecar bundle not found at ${bundle}; starting sidecars from ${source} (run \`bun run vendor:build\`).`);
  return source;
}
