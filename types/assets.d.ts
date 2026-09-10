/**
 * Bun's `with { type: "file" }` imports resolve to a path string. TypeScript
 * has no built-in knowledge of them, so the two pglite assets the host embeds
 * are declared here.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.data" {
  const path: string;
  export default path;
}
