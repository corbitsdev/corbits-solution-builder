/**
 * Sidecar-bundle entry for `@solutions-builder/tools-delivery`, following
 * `@solutions-builder/tools-deck`'s convention: stage 9's `deliver` tool,
 * which raises the person's acceptance decision.
 *
 * There is no tool here for scoring checks. The deterministic checks run at
 * stage 8, inside `publish_workspace` (`verify.ts`), and travel on the
 * manifest it uploads; stage 9 reads them and claims nothing of its own
 * (#129). The `delivery_status` tool that once summarized a model's own
 * scores is gone with them (#32).
 */
import { defineTool, type BaseEnv } from "@intx/agent";

export const DELIVER_TOOL_NAME = "deliver";

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`deliver: "${key}" must be a non-empty string`);
  }
  return value;
}

type DeliverArgs = {
  manifestNodeId: string;
  summary: string;
  artifacts: { path: string; contentHash: string }[];
};

function parseArtifact(raw: unknown): { path: string; contentHash: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('deliver: each entry in "artifacts" must be an object');
  }
  const record = raw as Record<string, unknown>;
  const path = record["path"];
  const contentHash = record["contentHash"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('deliver: "artifacts[].path" must be a non-empty string');
  }
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    throw new Error('deliver: "artifacts[].contentHash" must be a non-empty string');
  }
  return { path, contentHash };
}

function parseDeliverArgs(args: Record<string, unknown>): DeliverArgs {
  const rawArtifacts = args["artifacts"];
  if (!Array.isArray(rawArtifacts)) throw new Error('deliver: "artifacts" must be an array');
  return {
    manifestNodeId: requireString(args, "manifestNodeId"),
    summary: requireString(args, "summary"),
    artifacts: rawArtifacts.map(parseArtifact),
  };
}

/**
 * Submits the delivery for a person's decision. Marked `approval: "ask"`
 * (`@intx/agent`'s tool-level gate, not `@solutions-builder/kit`'s capability
 * grants): calling it parks the specialist's own agent step and the hub
 * writes a pending `approval` row (`db/src/schema/approvals.ts`) rather than
 * waiting on a named workflow signal the way every other stage's gate does.
 * A stakeholder approves or rejects through the stock `POST
 * /approvals/:id/approve|reject` routes; approved resolves the call and the
 * specialist's step ends — stage 9 is delivered. Rejected (optionally with a
 * message) resolves the call as a refusal the specialist sees in its own
 * tool result, so it revises and calls `deliver` again in the same turn.
 *
 * The handler itself only runs once approved (the platform never invokes it
 * on a rejected call), and does nothing beyond confirm the submission that
 * was just approved — the approval row's own resolution is the record; there
 * is no ledger write left for a tool package to make.
 */
export const deliver = defineTool<BaseEnv>({
  id: "@solutions-builder/tools-delivery/deliver",
  definitions: [{ name: DELIVER_TOOL_NAME, approval: "ask" }],
  factory: () => ({
    definitions: [
      {
        name: DELIVER_TOOL_NAME,
        approval: "ask",
        description:
          "Submit the delivery manifest for a stakeholder's decision. Parks until a person approves or rejects it. Approved means the software is delivered; rejected carries the person's message back so the delivery can be revised and resubmitted.",
        inputSchema: {
          type: "object",
          properties: {
            manifestNodeId: { type: "string", description: "The manifest version being delivered" },
            summary: { type: "string", description: "One paragraph describing what is being delivered" },
            artifacts: {
              type: "array",
              description: "The exact artifacts this delivery carries",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  contentHash: { type: "string" },
                },
                required: ["path", "contentHash"],
              },
            },
          },
          required: ["manifestNodeId", "summary", "artifacts"],
        },
      },
    ],
    run: async (call, signal) => {
      try {
        signal.throwIfAborted();
        const args = parseDeliverArgs(call.arguments);
        return { callId: call.id, content: `Delivered manifest ${args.manifestNodeId}: ${args.summary}` };
      } catch (err) {
        return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  }),
});
