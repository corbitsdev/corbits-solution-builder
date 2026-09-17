import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// `@intx/hub-client` ships TypeScript source, not a published `dist/`. Vite
// would load its tsconfig, which extends `../../tsconfig.base.json` — a file
// the vendor copy does not include. Alias the package to its entry and skip
// tsconfig lookup so the web bundle can import `@solutions-builder/installer`.
const hubClient = join(
  import.meta.dirname,
  "../../vendor/interchange/packages/hub-client/src/index.ts",
);

/** Bun's `with { type: "text" }` — Vite has no equivalent, so `.md` is a string. */
function markdownAsText(): Plugin {
  return {
    name: "markdown-as-text",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0] ?? id;
      if (!path.endsWith(".md")) return;
      return `export default ${JSON.stringify(readFileSync(path, "utf8"))};`;
    },
  };
}

/** Interchange dist files import node builtins the browser does not have. */
function stubNodeBuiltins(): Plugin {
  return {
    name: "stub-node-builtins",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:crypto" || id === "crypto") return join(import.meta.dirname, "node-crypto.ts");
      if (id === "node:path" || id === "path") return join(import.meta.dirname, "node-path.ts");
      if (id.startsWith("node:")) return `\0stub:${id}`;
    },
    load(id) {
      if (!id.startsWith("\0stub:node:")) return;
      return `const fail = () => { throw new Error(${JSON.stringify(`${id.slice("\0stub:".length)} is not available in the web bundle`)}); };
const dummy = new Proxy(fail, { get: () => dummy, apply: () => dummy });
export default dummy;
export const createHash = dummy;
export const readFile = dummy;
export const readFileSync = dummy;
export const writeFile = dummy;
export const writeFileSync = dummy;
export const mkdir = dummy;
export const mkdirSync = dummy;
export const existsSync = dummy;
export const statSync = dummy;
export const readdirSync = dummy;
export const homedir = dummy;
export const tmpdir = dummy;
export const fileURLToPath = dummy;
export const pathToFileURL = dummy;
export const cwd = dummy;
export const env = {};
`;
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [stubNodeBuiltins(), markdownAsText(), react()],
  resolve: {
    alias: {
      "@intx/hub-client": hubClient,
    },
  },
  esbuild: {
    // A string skips Vite's tsconfck load (an object still reads the nearest
    // tsconfig and fails the missing extends). Hub-client's tsconfig is that
    // nearest file once the installer import pulls it in.
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        target: "esnext",
        isolatedModules: true,
      },
    }),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The bundle must be self-contained and offline-safe: no remote fonts, no
    // CDN, nothing the host's CSP would have to be loosened for.
    assetsInlineLimit: 0,
  },
});
