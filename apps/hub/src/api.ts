/**
 * The versioned local Hub API.
 *
 * Every client — the Tauri window, the tray, a later CLI — consumes only this.
 * That is what makes the cloud move in PRD section 5 an endpoint change rather
 * than a rewrite, and it is why no route here reaches into a React component's
 * assumptions.
 *
 * Two invariants the route layer owns:
 *   - external input is validated once, here, at the boundary that owns it;
 *   - no response body ever contains a secret.
 *
 * Routes are split by resource across api-*.ts modules, each exporting one
 * `register*Routes(api)` function; this file wires them together and owns
 * the auth-adjacent helpers and error handling shared across all of them.
 */
import { Hono } from "hono";
import { type } from "arktype";
import { resolveWorkspace } from "./hub-client.js";
import { currentSession } from "./hub-session.js";
import { HostError } from "./errors.js";
import { registerHostRoutes, API_VERSION as HOST_API_VERSION } from "./api-host.js";

export const API_VERSION = HOST_API_VERSION;


export function parsed<T>(result: T | type.errors): T {
  if (result instanceof type.errors) {
    throw new HostError("validation_failed", result.summary);
  }
  return result;
}

export function createApi() {
  const api = new Hono();

  api.use("*", async (_, next) => {
    if (currentSession()) await resolveWorkspace().catch(() => null);
    await next();
  });

  registerHostRoutes(api);

  api.onError((cause, context) => {
    const correlationId = `cor_${crypto.randomUUID()}`;
    if (cause instanceof HostError) {
      return context.json(cause.body(correlationId), cause.status as 400);
    }
    // An unexpected failure gets a safe message and a correlation id; the
    // detail stays in the host log rather than in a client response.
    console.error(`[${correlationId}]`, cause);
    return context.json(
      {
        error: {
          code: "internal_error",
          message: "The host failed to complete that request.",
          correlationId,
          retryable: false,
        },
      },
      500,
    );
  });

  return api;
}
