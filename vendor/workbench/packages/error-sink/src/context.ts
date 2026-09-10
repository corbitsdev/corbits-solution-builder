// The structured shape every `reportError` call carries (CL-6496): the
// operation that failed, optional tenant/room/agent identifiers scoping
// it, and a `refId` a person can quote back to support -- the same
// `refId` pattern `packages/onboarding/src/routes.ts`'s
// `reportOnboardingError` already establishes (see this package's own
// `generateRefId` / `makeErrorEnvelope`). Free-form detail
// beyond these named fields belongs in `extra`, never inlined into a
// string message.
import { type } from "arktype";

export const ErrorContext = type({
  operation: "string > 0",
  "tenantId?": "string > 0",
  "roomId?": "string > 0",
  "agentId?": "string > 0",
  "refId?": "string > 0",
  "extra?": "Record<string, unknown>",
});

export type ErrorContext = typeof ErrorContext.infer;
