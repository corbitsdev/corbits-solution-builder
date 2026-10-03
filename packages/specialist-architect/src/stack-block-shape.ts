/**
 * The Stack record's shape as a specialist is told it (#617): the Architect's
 * prompt and the ask the gate's banner sends (`stage-evidence.ts`) both quote
 * this, so what is asked for is what `StackRecordSchema` in the app's
 * `stack.ts` accepts. A field added to the schema is added here; the app's
 * `stack.test.ts` holds the two together.
 */
export const STACK_BLOCK_SHAPE = `
{
  "mode": one of "plain" | "inference" | "agent" | "local-workflow" |
    "durable-workflow" | "hub",
  "hubPlacement": "embedded" | "cloud" (only when mode is "hub"),
  "runtime": { "choice": string, "reason": string, "cites": [requirement id, ...] },
  "ui": same shape as "runtime", or null,
  "storage": same shape as "runtime", or null,
  "auth": same shape as "runtime", or null,
  "packaging": { "choice", "reason", "cites", "kind": "compiled-binary" |
    "web-hosted" | "desktop" | "cli" | "library" },
  "packages": [{ "choice", "reason", "cites", "name": string }, ...],
  "deferred": [string, ...]
}
`.trim();
