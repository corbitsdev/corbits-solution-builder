/**
 * Turning a provider's failure into something a person can act on.
 *
 * Providers answer errors as JSON, and that JSON must never reach the
 * interface. `{"error":{"type":"usage_limit_reached",…,"resets_in_seconds":3978}}`
 * tells a reader nothing they can use, and showing it is the interface giving
 * up and handing over its notes.
 *
 * Every provider call goes through `describeProviderFailure`, which produces a
 * sentence and — where one exists — the action that would fix it. The raw body
 * is kept only in the host log.
 */
import type { InferenceError } from "@intx/types/runtime";
import type { ErrorCode } from "../../host/errors.js";

/** What the interface should offer, beyond reading the message. */
export type Remediation =
  | { kind: "switch_provider"; label: string }
  | { kind: "reconnect"; providerId: string; label: string }
  | { kind: "retry"; label: string; afterSeconds?: number };

export type ProviderFailure = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly remediation?: Remediation;
};

/** Anything a provider might nest an error message under. */
function extractMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // `{"error": "…"}` is as common as `{"error": {"message": "…"}}`.
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    const message = error.message ?? parsed.detail ?? parsed.message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
  } catch {
    // Not JSON. Plain text is only useful if it is short enough to be a
    // sentence rather than a page of HTML from a proxy.
    const trimmed = body.trim();
    return trimmed.length > 0 && trimmed.length <= 200 && !trimmed.startsWith("<")
      ? trimmed
      : null;
  }
}

function extractResetSeconds(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    const seconds = error.resets_in_seconds ?? parsed.resets_in_seconds;
    return typeof seconds === "number" && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** "in about an hour" reads better than 3978. */
export function humanDuration(seconds: number): string {
  if (seconds < 90) return "in under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function describeProviderFailure(args: {
  providerLabel: string;
  providerId: string;
  status: number;
  body: string;
}): ProviderFailure {
  const { providerLabel, providerId, status, body } = args;
  const detail = extractMessage(body);

  // Rate limited or out of quota. The useful offer is another provider, because
  // waiting is the only alternative and it may be hours.
  if (status === 429) {
    const resets = extractResetSeconds(body);
    return {
      code: "provider_unavailable",
      message:
        `${providerLabel} has no capacity left right now` +
        (resets ? `; it resets ${humanDuration(resets)}.` : ".") +
        " Connect another provider to keep going.",
      retryable: true,
      remediation: { kind: "switch_provider", label: "Connect another provider" },
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: "not_authorized",
      message: `${providerLabel} rejected the credentials for this request.`,
      retryable: false,
      remediation: {
        kind: "reconnect",
        providerId,
        label: `Reconnect ${providerLabel}`,
      },
    };
  }

  // Payment required: the account is out of balance or the plan does not cover
  // this. Neither waiting nor reconnecting fixes it, so the offer is a
  // different provider.
  if (status === 402) {
    return {
      code: "provider_unavailable",
      message:
        `${providerLabel} has no balance left${detail ? ` (${detail.toLowerCase()})` : ""}. ` +
        "Top it up, or use a different provider.",
      retryable: false,
      remediation: { kind: "switch_provider", label: "Connect another provider" },
    };
  }

  if (status === 404) {
    return {
      code: "upstream_mismatch",
      message:
        `${providerLabel} does not serve the selected model. Pick a different one in Settings.`,
      retryable: false,
      remediation: { kind: "switch_provider", label: "Choose another model" },
    };
  }

  if (status >= 500) {
    return {
      code: "provider_unavailable",
      message: `${providerLabel} is having trouble on its side${detail ? `: ${detail}` : "."}`,
      retryable: true,
      remediation: { kind: "retry", label: "Try again" },
    };
  }

  // Everything else. The provider's own sentence is used when it produced one,
  // because it is usually the most specific thing available — but only the
  // sentence, never the envelope it arrived in.
  return {
    code: "provider_unavailable",
    message: detail
      ? `${providerLabel}: ${detail}`
      : `${providerLabel} could not complete the request (HTTP ${status}).`,
    retryable: status === 408 || status === 409,
    remediation: { kind: "switch_provider", label: "Connect another provider" },
  };
}

/**
 * Turns a classified `InferenceError` from the `@intx/inference` harness into
 * the sentence and remediation a person sees. An HTTP-classified error (one
 * `classifyHTTPError` produced from a real response, carrying `statusCode`)
 * reuses `describeProviderFailure`'s status-code sentences above; everything
 * else — a network failure, a stalled connection, a cancelled request — has
 * no HTTP status to read and gets a plain host-authored message instead.
 *
 * The raw body/message is logged for operators and dropped from what the
 * caller returns, same discipline as `describeProviderFailure`.
 */
export function describeInferenceFailure(args: {
  providerLabel: string;
  providerId: string;
  error: InferenceError;
}): ProviderFailure {
  const { providerLabel, providerId, error } = args;

  if (error.statusCode !== undefined) {
    const body =
      typeof error.raw === "string"
        ? error.raw
        : JSON.stringify(error.raw ?? { message: error.message });
    console.error(`[${providerId}] HTTP ${error.statusCode}: ${body.slice(0, 500)}`);
    return describeProviderFailure({ providerLabel, providerId, status: error.statusCode, body });
  }

  console.error(`[${providerId}] ${error.category}: ${error.message}`);

  if (error.category === "aborted") {
    return { code: "validation_failed", message: "The request was cancelled.", retryable: false };
  }

  // Network failures, stalled streams, protocol mismatches and quota
  // exhaustion without a status code: none of these are fixed by waiting on
  // this provider, so the offer is always another one.
  return {
    code: "provider_unavailable",
    message: `${providerLabel} did not answer (${error.message}).`,
    retryable: true,
    remediation: { kind: "switch_provider", label: "Connect another provider" },
  };
}
