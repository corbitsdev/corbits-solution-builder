/**
 * Sidecar-bundle entry for `@solutions-builder/tools-delivery`, following
 * `@solutions-builder/tools-deck`'s convention.
 *
 * The tool turns a manifest's already-checked items into the completeness
 * report and one-sentence blocker summary the decision queue shows, calling
 * `summarizeVerification`/`describeBlockers` from `@solutions-builder/app/delivery`
 * — the same deterministic evidence logic `apps/hub/src/delivery.ts` uses.
 * Checking each descriptor against the build workspace (`hashFile`,
 * `checkDescriptor`) stays host-side: it reads the workspace's actual files
 * and the project's database, neither of which a tool package may touch, so
 * a caller runs those checks first and hands this tool their results.
 */
import { defineTool, type BaseEnv } from "@intx/agent";
import {
  describeBlockers,
  summarizeVerification,
  VERIFICATION_STATUSES,
  DESCRIPTOR_CATEGORIES,
  type VerificationItem,
  type VerificationStatus,
} from "@solutions-builder/app/delivery";

export const TOOL_NAME = "delivery_status";
export const DELIVER_TOOL_NAME = "deliver";

type DeliveryStatusArgs = {
  manifestNodeId: string;
  checkedAt: string;
  items: VerificationItem[];
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`delivery_status: "${key}" must be a non-empty string`);
  }
  return value;
}

function parseItem(raw: unknown): VerificationItem {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('delivery_status: each entry in "items" must be an object');
  }
  const record = raw as Record<string, unknown>;
  const category = record["category"];
  const path = record["path"];
  const required = record["required"];
  const status = record["status"];
  if (typeof category !== "string" || !(DESCRIPTOR_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`delivery_status: "items[].category" must be one of ${DESCRIPTOR_CATEGORIES.join(", ")}`);
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('delivery_status: "items[].path" must be a non-empty string');
  }
  if (typeof required !== "boolean") {
    throw new Error('delivery_status: "items[].required" must be a boolean');
  }
  if (typeof status !== "string" || !(VERIFICATION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`delivery_status: "items[].status" must be one of ${VERIFICATION_STATUSES.join(", ")}`);
  }
  const detail = record["detail"];
  return {
    category: category as VerificationItem["category"],
    path,
    required,
    status: status as VerificationStatus,
    ...(typeof detail === "string" ? { detail } : {}),
  };
}

function parseArgs(args: Record<string, unknown>): DeliveryStatusArgs {
  const rawItems = args["items"];
  if (!Array.isArray(rawItems)) throw new Error('delivery_status: "items" must be an array');
  return {
    manifestNodeId: requireString(args, "manifestNodeId"),
    checkedAt: requireString(args, "checkedAt"),
    items: rawItems.map(parseItem),
  };
}

async function deliveryStatusContent(rawArgs: Record<string, unknown>): Promise<string> {
  const args = parseArgs(rawArgs);
  const report = summarizeVerification(args.manifestNodeId, args.items, new Date(args.checkedAt));
  const blockers = describeBlockers(report);
  return JSON.stringify({ report, blockers });
}

export const delivery = defineTool<BaseEnv>({
  id: "@solutions-builder/tools-delivery/delivery-status",
  definitions: [{ name: TOOL_NAME }],
  factory: () => ({
    definitions: [
      {
        name: TOOL_NAME,
        description:
          "Summarize a delivery manifest's already-checked descriptors into a completeness report and a one-sentence blocker summary. Does not check anything itself: the caller checks each descriptor against the build workspace first and passes the results as \"items\".",
        inputSchema: {
          type: "object",
          properties: {
            manifestNodeId: { type: "string", description: "The manifest version these checks ran against" },
            checkedAt: { type: "string", description: "ISO timestamp of the check" },
            items: {
              type: "array",
              description: "One entry per descriptor, already checked against the build workspace",
              items: {
                type: "object",
                properties: {
                  category: { type: "string", enum: [...DESCRIPTOR_CATEGORIES] },
                  path: { type: "string" },
                  required: { type: "boolean" },
                  status: { type: "string", enum: [...VERIFICATION_STATUSES] },
                  detail: { type: "string" },
                },
                required: ["category", "path", "required", "status"],
              },
            },
          },
          required: ["manifestNodeId", "checkedAt", "items"],
        },
      },
    ],
    run: async (call, signal) => {
      try {
        signal.throwIfAborted();
        const content = await deliveryStatusContent(call.arguments);
        return { callId: call.id, content };
      } catch (err) {
        return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  }),
});

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
