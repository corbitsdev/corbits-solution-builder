import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
// `@corbits/oauth-core`'s package.json only exposes the "." entry (its
// `src/index.ts` barrel), which re-exports the desktop-only `browser.ts`
// (spawns a system browser) and `callback-server.ts` (a loopback HTTP
// server) alongside the token-exchange helpers the providers below actually
// use. Those Node-only files would drag `node:child_process`/`os`/`http`/
// `net` into the web bundle, so this resolves the package directory and
// points a browser-safe shim straight at its `client.ts`/`tokens.ts`.
const oauthCoreDir = dirname(require.resolve("@corbits/oauth-core"));

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
export const platform = dummy;
export const arch = dummy;
export const hostname = dummy;
export const release = dummy;
export const type = dummy;
export const spawn = dummy;
export const spawnSync = dummy;
export const exec = dummy;
export const execSync = dummy;
export const fork = dummy;
`;
    },
  };
}

/**
 * `@corbits/codex-provider` and `@corbits/xai-provider` import only
 * `exchangeCode`, `refreshTokenRequest`, `baseTokensFromResponse`, and the
 * `BaseTokens`/`OAuthClientConfig` types from `@corbits/oauth-core` — all
 * defined in its Node-free `client.ts`/`tokens.ts`. Redirect the barrel
 * import to a virtual module built from those two files directly, skipping
 * the desktop-only `browser.ts`/`callback-server.ts` re-exports (see above).
 */
function oauthCoreBrowserShim(): Plugin {
  const virtualId = "\0oauth-core-browser-shim";
  return {
    name: "oauth-core-browser-shim",
    enforce: "pre",
    resolveId(id) {
      if (id === "@corbits/oauth-core") return virtualId;
    },
    load(id) {
      if (id !== virtualId) return;
      return `export {
  buildAuthorizeUrl,
  baseTokensFromResponse,
  exchangeCode,
  refreshTokenRequest,
  OAuthTokenEndpointError,
  OAuthTokenResponseSchemaError,
  OAuthMissingRefreshTokenError,
} from ${JSON.stringify(join(oauthCoreDir, "client.ts"))};
`;
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [stubNodeBuiltins(), oauthCoreBrowserShim(), markdownAsText(), react()],
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
