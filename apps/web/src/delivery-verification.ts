/**
 * Per-file verification for stage 9's decision (CL-8728).
 *
 * `delivery_status`'s tool arguments and a `delivery_verification`/
 * `delivery_manifest` artifact's content (`packages/solutions-builder/src/delivery.ts`'s
 * `VerificationReport`/`VerificationItem`) both carry the same `items` shape:
 * one entry per descriptor with `category`, `path`, `required` and a
 * `status` of `"verified" | "missing" | "hash_mismatch" | "inaccessible"`.
 * Neither shape is trusted here — a status this module does not recognize,
 * or a descriptor never mentioned, is `"unverified"`, never `"passed"`.
 */

export type VerificationRowStatus = "passed" | "failed" | "unverified";

export type VerificationRow = {
  path: string;
  kind?: string;
  sha256?: string;
  sizeBytes?: number;
  status: VerificationRowStatus;
  note?: string;
};

export type DeliveryVerification = {
  rows: VerificationRow[];
  summary: { passed: number; failed: number; unverified: number };
  problems: string[];
};

const STATUS_MAP: Record<string, VerificationRowStatus> = {
  verified: "passed",
  missing: "failed",
  hash_mismatch: "failed",
  inaccessible: "unverified",
  passed: "passed",
  failed: "failed",
  unverified: "unverified",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwraps the envelopes `delivery_status`'s tool result and a manifest's own content can arrive in. */
function unwrapItems(input: unknown, problems: string[]): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return null;
  if (Array.isArray(input["items"])) return input["items"] as unknown[];
  // `delivery_status`'s own JSON result: `{ report: VerificationReport, blockers }`.
  if (isRecord(input["report"])) return unwrapItems(input["report"], problems);
  // A `delivery_manifest` artifact's optional embedded `verification` field.
  if ("verification" in input && input["verification"] !== undefined) {
    return unwrapItems(input["verification"], problems);
  }
  return null;
}

function parseRow(raw: unknown, problems: string[]): VerificationRow | null {
  if (!isRecord(raw)) {
    problems.push("a verification entry was not an object");
    return null;
  }
  const path = typeof raw["path"] === "string" && raw["path"].length > 0
    ? raw["path"]
    : typeof raw["name"] === "string" && raw["name"].length > 0
      ? raw["name"]
      : null;
  if (!path) {
    problems.push("a verification entry is missing its path");
    return null;
  }
  const kind = typeof raw["category"] === "string" ? raw["category"] : typeof raw["kind"] === "string" ? raw["kind"] : undefined;
  const sha256 = typeof raw["sha256"] === "string" ? raw["sha256"] : undefined;
  const sizeBytes = typeof raw["sizeBytes"] === "number" ? raw["sizeBytes"] : undefined;
  const note = typeof raw["detail"] === "string" ? raw["detail"] : typeof raw["note"] === "string" ? raw["note"] : undefined;

  const rawStatus = raw["status"];
  const mapped = typeof rawStatus === "string" ? STATUS_MAP[rawStatus] : undefined;
  const status: VerificationRowStatus = mapped ?? "unverified";
  if (!mapped) {
    problems.push(`"${path}" has an unrecognized status${typeof rawStatus === "string" ? ` "${rawStatus}"` : ""}`);
  }

  return { path, ...(kind ? { kind } : {}), ...(sha256 ? { sha256 } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), status, ...(note ? { note } : {}) };
}

/** Never throws: malformed or missing input is reported in `problems`, never surfaced as a passing check. */
export function parseDeliveryVerification(input: unknown): DeliveryVerification {
  const problems: string[] = [];
  try {
    if (input === null || input === undefined) {
      return { rows: [], summary: { passed: 0, failed: 0, unverified: 0 }, problems: ["verification is missing"] };
    }
    const rawItems = unwrapItems(input, problems);
    if (!rawItems) {
      return { rows: [], summary: { passed: 0, failed: 0, unverified: 0 }, problems: ["verification could not be read"] };
    }
    const rows = rawItems.map((raw) => parseRow(raw, problems)).filter((row): row is VerificationRow => row !== null);
    const summary = rows.reduce(
      (acc, row) => {
        acc[row.status] += 1;
        return acc;
      },
      { passed: 0, failed: 0, unverified: 0 },
    );
    return { rows, summary, problems };
  } catch (cause) {
    return {
      rows: [],
      summary: { passed: 0, failed: 0, unverified: 0 },
      problems: [`verification could not be read: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
}
