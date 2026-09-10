/**
 * The error contract — BUILD_PLAN_V3 section 6, "Errors".
 *
 * Every failure that reaches a client carries a stable code, a safe message and
 * a correlation id. The distinction that matters most here: a resource in
 * another scope is *not found*, never *forbidden* — visibility is itself scoped.
 */
export const ERROR_CODES = [
  "validation_failed",
  "unauthenticated",
  "not_authorized",
  "not_found",
  "conflict",
  "stale_revision",
  "transition_refused",
  "provider_unavailable",
  "worker_unavailable",
  "upstream_mismatch",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  not_authorized: 403,
  not_found: 404,
  conflict: 409,
  stale_revision: 409,
  transition_refused: 409,
  provider_unavailable: 503,
  worker_unavailable: 503,
  upstream_mismatch: 502,
  internal_error: 500,
};

export class HostError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  /**
   * What the interface can offer beyond the message. Present when the failure
   * has an obvious next move — connect another provider, reconnect this one —
   * so the person is not left reading a sentence with nothing to click.
   */
  remediation?: { kind: string; label: string; providerId?: string; afterSeconds?: number };

  constructor(
    code: ErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }

  get status(): number {
    return STATUS[this.code];
  }

  body(correlationId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        correlationId,
        retryable: this.retryable,
        ...(this.remediation ? { remediation: this.remediation } : {}),
        ...this.detail,
      },
    };
  }
}

export const notFound = (what: string) =>
  new HostError("not_found", `${what} was not found.`);
