/**
 * The Estimator's forecast as data: the one fenced ```json estimate block its
 * prompt asks for (`kit.ts`), beside the prose a person reads. Stage 7's
 * summary is drawn from this block alone, never from the prose.
 */
import { type } from "arktype";

const EstimateRecordSchema = type({
  lines: type({ label: "string", amount: "string", basis: "string" }).array(),
  scope: "string[]",
});

export type EstimateRecord = typeof EstimateRecordSchema.infer;

export type EstimateRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "read"; readonly record: EstimateRecord };

const ESTIMATE_FENCE = "```json estimate\n";

function estimateBlock(markdown: string): { open: number; start: number; end: number } | null {
  const open = markdown.indexOf(ESTIMATE_FENCE);
  if (open < 0) return null;
  const start = open + ESTIMATE_FENCE.length;
  return { open, start, end: markdown.indexOf("```", start) };
}

/** The markdown a person reads: the forecast block is data for the table. */
export function withoutEstimateBlock(markdown: string): string {
  const block = estimateBlock(markdown);
  if (!block || block.end < 0) return markdown;
  return markdown.slice(0, block.open) + markdown.slice(block.end + 3);
}

export function readEstimateRecord(markdown: string): EstimateRead {
  const block = estimateBlock(markdown);
  if (!block) return { status: "absent" };
  const { start, end } = block;
  if (end < 0) return { status: "invalid", reason: "the block is not closed" };
  let json: unknown;
  try {
    json = JSON.parse(markdown.slice(start, end));
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  const parsed = EstimateRecordSchema(json);
  return parsed instanceof type.errors ? { status: "invalid", reason: parsed.summary } : { status: "read", record: parsed };
}
