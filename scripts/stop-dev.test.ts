import { describe, expect, test } from "bun:test";
import { solutionsBuilderProcesses, stopOrder } from "./stop-dev.js";

const PS = [
  "44542 bun scripts/dev.ts",
  "44562 node /Users/x/solutions-builder-alpha/node_modules/.bin/vite build -c /Users/x/solutions-builder-alpha/apps/web/vite.config.ts --watch",
  "44563 bun /Users/x/solutions-builder-alpha/apps/hub/src/server.ts --open",
  "54830 bun --conditions intx-src apps/hub/src/server.ts --port 0",
  "64807 bun /Users/x/solutions-builder-main/vendor/interchange/apps/sidecar/src/index.ts",
  "70001 node /Users/x/other-app/node_modules/.bin/vite build -c apps/web/vite.config.ts",
  "70002 bun scripts/adopt-legacy-projects.ts",
  "70003 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer",
  "70004 bunx @tauri-apps/cli@2 dev --config {}",
  // A shell whose command merely mentions the paths: a grep, or this script's own proof run.
  "70005 bash -c ps -axo pid,command | grep -E 'apps/hub/src/server.ts|apps/sidecar/src/index.ts|scripts/dev.ts'",
  "70006 /bin/sh -c bun apps/hub/src/server.ts --port 0 > host.log 2>&1 &",
];
const OWN = { pid: 99999, ppid: 99998 };

describe("solutionsBuilderProcesses", () => {
  test("finds the launcher, hosts, watcher, shell and sidecar from any checkout, and nothing else", () => {
    const found = solutionsBuilderProcesses(PS, OWN);
    expect(found.map((entry) => [entry.pid, entry.role])).toEqual([
      [44542, "launcher"],
      [44562, "watcher"],
      [44563, "host"],
      [54830, "host"],
      [64807, "sidecar"],
      [70001, "watcher"],
      [70004, "shell"],
    ]);
  });

  test("never lists itself or the shell that ran it", () => {
    expect(solutionsBuilderProcesses(["123 bun scripts/dev.ts", "122 bun scripts/dev.ts"], { pid: 123, ppid: 122 })).toEqual([]);
  });
});

describe("stopOrder", () => {
  test("launchers and hosts before watchers, sidecars last", () => {
    const ordered = stopOrder(solutionsBuilderProcesses(PS, OWN));
    expect(ordered.map((entry) => entry.role)).toEqual(["launcher", "shell", "host", "host", "watcher", "watcher", "sidecar"]);
  });
});
