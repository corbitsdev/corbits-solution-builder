import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { type } from "arktype";

import { agentSession, inferenceTurn, turnPart, sessionMail } from "@intx/db/schema";
import type { DB, PrincipalKeyStore } from "@intx/db";
import { ErrorResponse } from "@intx/types";
import { createDetachedSignatureWithSigner } from "@intx/crypto";
import { assembleMessage, assembleSignedContent, generateMessageId } from "@intx/mime";
import { generateId } from "@intx/hub-common";

import type { TenantEnv } from "../context";
import type { RequireGrant } from "../middleware/grant";

const MAIL_DOMAIN = "local.solutions-builder.invalid";

function addressOf(principalId: string): string {
  return `${principalId}@${MAIL_DOMAIN}`;
}

/**
 * A session belongs to exactly the tenant it was created in; a caller
 * authorized against `:tenantId` in the URL must not be able to read or
 * write another tenant's session by guessing its id. Mirrors
 * `resolveAssetById`'s tenant-scoped lookup in `assets.ts`.
 */
async function resolveSession(
  db: DB["db"],
  tenantId: string,
  sessionId: string,
): Promise<boolean> {
  const row = await db.query.agentSession.findFirst({
    where: and(eq(agentSession.id, sessionId), eq(agentSession.tenantId, tenantId)),
  });
  return row !== undefined;
}

async function ensureSigningKey(
  principalKeyStore: PrincipalKeyStore,
  principalId: string,
): Promise<void> {
  try {
    await principalKeyStore.generate(principalId);
  } catch {
    // The partial unique index on (principalId, active) is what makes this
    // idempotent: a principal that already has an active key throws here,
    // which is exactly "nothing to do".
  }
}

const EnsureAgentSession = type({
  sessionId: "string > 0",
  definitionId: "string > 0",
  principalId: "string > 0",
});

const WriteConversationTurn = type({
  // Empty is a legitimate value: a turn not tied to any run (e.g. an
  // inference-usage event recorded outside a build attempt) carries "".
  runId: "string",
  role: "'human' | 'specialist'",
  body: "string",
  fromPrincipalId: "string > 0",
  toPrincipalId: "string > 0",
  metadata: "Record<string, unknown>",
  model: "string > 0",
});

const WriteConversationTurnResponse = type({
  id: "string",
});

const ConversationTurnResponse = type({
  id: "string",
  content: "string",
  "metadata?": "Record<string, unknown> | null",
  startedAt: "string",
});

export type CreateSessionRoutesDeps = {
  db: DB["db"];
  principalKeyStore: PrincipalKeyStore;
  requireGrant: RequireGrant;
};

/**
 * Sessions, and the conversation turns recorded against them. `agent_session`
 * is keyed to a `workflow_definition`, not a live agent instance -- a session
 * launched interactively or kept by a host that reads its own command ledger
 * back through `inference_turn`/`turn_part`, mirroring the mail the platform
 * expects (`session_mail`).
 */
export function createSessionRoutes({
  db,
  principalKeyStore,
  requireGrant,
}: CreateSessionRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post(
    "/",
    requireGrant("agent-session:*", "create"),
    describeRoute({
      tags: ["Sessions"],
      summary: "Ensure an agent session",
      description:
        "Finds or creates an agent_session with a caller-chosen id, keyed to a workflow definition. Idempotent on id.",
      responses: {
        200: { description: "Session ensured" },
      },
    }),
    validator("json", EnsureAgentSession),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const body = c.req.valid("json");
      await db
        .insert(agentSession)
        .values({
          id: body.sessionId,
          tenantId: tenantCtx.id,
          agentId: body.definitionId,
          principalId: body.principalId,
          status: "active",
        })
        .onConflictDoNothing();
      return c.body(null, 200);
    },
  );

  app.post(
    "/:sessionId/turns",
    requireGrant("agent-session:*", "manage"),
    describeRoute({
      tags: ["Sessions"],
      summary: "Write a conversation turn",
      description:
        "Writes one turn: the session_mail record the platform expects, and the inference_turn/turn_part pair a command ledger reads back as one committed command's metadata.",
      responses: {
        200: {
          description: "Turn written",
          content: {
            "application/json": {
              schema: resolver(WriteConversationTurnResponse),
            },
          },
        },
        400: {
          description: "Validation error",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "No session with this id in this tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    validator("json", WriteConversationTurn),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const sessionId = c.req.param("sessionId");
      const body = c.req.valid("json");

      if (!(await resolveSession(db, tenantCtx.id, sessionId))) {
        return c.json(
          { error: { code: "not_found", message: "Session not found" } },
          404,
        );
      }

      await ensureSigningKey(principalKeyStore, body.fromPrincipalId);
      const from = addressOf(body.fromPrincipalId);
      const signedContent = assembleSignedContent({
        kind: "conversation",
        text: body.body,
      });
      const signature = await createDetachedSignatureWithSigner(
        signedContent,
        (input) => principalKeyStore.sign(body.fromPrincipalId, input),
      );
      const raw = assembleMessage(
        {
          from,
          to: [addressOf(body.toPrincipalId)],
          cc: undefined,
          date: new Date(),
          messageId: generateMessageId(from),
          subject: undefined,
          inReplyTo: undefined,
          references: undefined,
          mimeVersion: "1.0",
          interchangeType: "conversation.message",
          interchangeCorrelationId: undefined,
          interchangeTenantId: tenantCtx.id,
          interchangeAgentId: undefined,
          interchangeSessionId: sessionId,
          interchangeOfferingId: undefined,
          interchangeSchemaVersion: undefined,
          traceparent: undefined,
          tracestate: undefined,
        },
        signedContent,
        signature,
      );

      const mailId = generateId("sessionMail");
      const turnId = generateId("inferenceTurn");
      const partId = generateId("turnPart");
      const now = new Date();

      // Sequential inserts, not one transaction: this handle is a single-
      // writer connection shared with the rest of the host, and a caller
      // elsewhere may already be inside its own transaction on it when this
      // runs. The read path is inference_turn joined to turn_part, and the
      // turn's words live on the part -- those two go first, so an
      // interrupted write leaves either nothing or a whole, readable turn.
      // session_mail is the platform's mirror and goes last.
      await db
        .insert(inferenceTurn)
        .values({
          id: turnId,
          sessionId,
          runId: body.runId,
          tenantId: tenantCtx.id,
          model: body.model,
          status: "completed",
          startedAt: now,
          endedAt: now,
        })
        .onConflictDoNothing();

      const existing = await db
        .select()
        .from(turnPart)
        .where(eq(turnPart.sessionId, sessionId));
      const ordinal = existing.reduce(
        (high, row) => Math.max(high, (Number(row.ordinal) || 0) + 1),
        0,
      );

      await db
        .insert(turnPart)
        .values({
          id: partId,
          turnId,
          sessionId,
          type: "text",
          content: body.body,
          metadata: body.metadata,
          ordinal,
        })
        .onConflictDoNothing();
      await db
        .insert(sessionMail)
        .values({
          id: mailId,
          sessionId,
          runId: null,
          tenantId: tenantCtx.id,
          direction: body.role === "human" ? "inbound" : "outbound",
          status: "delivered",
          raw,
          createdAt: now,
        })
        .onConflictDoNothing();

      return c.json({ id: partId });
    },
  );

  app.get(
    "/:sessionId/turns",
    requireGrant("agent-session:*", "read"),
    describeRoute({
      tags: ["Sessions"],
      summary: "List a session's conversation turns",
      description:
        "Every part on the session, oldest turn first. A session id this tenant does not own -- including one not created yet -- reads as empty, not an error: a fresh project's ledger session is asked about before its first command ever creates it.",
      responses: {
        200: {
          description: "Conversation parts",
          content: {
            "application/json": {
              schema: resolver(ConversationTurnResponse.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const sessionId = c.req.param("sessionId");

      // Scoped to this tenant before any read: without it, a caller
      // authorized only for `tenantCtx.id` could read another tenant's
      // session turns by guessing its id, since turn_part carries no
      // tenant_id column of its own to filter on directly.
      if (!(await resolveSession(db, tenantCtx.id, sessionId))) {
        return c.json([]);
      }

      const [parts, turns] = await Promise.all([
        db.select().from(turnPart).where(eq(turnPart.sessionId, sessionId)),
        db
          .select()
          .from(inferenceTurn)
          .where(eq(inferenceTurn.sessionId, sessionId)),
      ]);

      const startedAt = new Map(
        turns.map((turn) => [
          String(turn.id),
          turn.startedAt instanceof Date
            ? turn.startedAt
            : new Date(String(turn.startedAt ?? 0)),
        ]),
      );

      const ordered = parts
        .map((part) => {
          const when = startedAt.get(String(part.turnId)) ?? new Date(0);
          return {
            id: String(part.id),
            content: typeof part.content === "string" ? part.content : "",
            metadata: (part.metadata as Record<string, unknown> | null) ?? null,
            when,
            ordinal: Number(part.ordinal) || 0,
          };
        })
        .sort(
          (a, b) =>
            a.when.getTime() - b.when.getTime() ||
            a.ordinal - b.ordinal ||
            a.id.localeCompare(b.id),
        )
        .map((part) => ({
          id: part.id,
          content: part.content,
          metadata: part.metadata,
          startedAt: part.when.toISOString(),
        }));

      return c.json(ordered);
    },
  );

  return app;
}
