// The one shape every hub route uses to answer a failure a user can see:
// a stable `code` a client can branch on, a `userMessage` written in
// consumer language, and a `refId` a person can quote in a support
// message or a bug report. The raw failure — stack text, file paths,
// upstream error prose — never crosses the wire; it belongs in the
// hub's own logger, keyed by the same `refId`, so an operator can find
// it without the client ever having seen it. See CL-6360.

import { type } from "arktype";
import { generateRefId } from "./ref-id";

export const ErrorEnvelopeShape = type({
  error: {
    code: "string",
    userMessage: "string",
    refId: "string",
  },
});

export type ErrorEnvelope = typeof ErrorEnvelopeShape.infer;

export function makeErrorEnvelope(args: {
  code: string;
  userMessage: string;
  refId?: string;
}): ErrorEnvelope {
  return {
    error: {
      code: args.code,
      userMessage: args.userMessage,
      refId: args.refId ?? generateRefId(),
    },
  };
}

/** Parses a hub error response body against `ErrorEnvelopeShape`. Returns
 * `undefined` for anything that doesn't match — malformed or legacy
 * bodies never crash a client that expected the envelope. */
export function parseErrorEnvelope(body: unknown): ErrorEnvelope | undefined {
  const parsed = ErrorEnvelopeShape(body);
  return parsed instanceof type.errors ? undefined : parsed;
}
