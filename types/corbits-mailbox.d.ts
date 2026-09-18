/**
 * Local declaration of the `@corbits/mailbox` surface Builder uses.
 *
 * The package is installed as a bare git dependency (never published to
 * npm); its own `prepare` script builds `dist/` on install, but that build
 * emits no rewritten `.d.ts` for its own vendored `@intx/*` copies (see
 * VENDORED.md in the package). Declaring the surface we actually call keeps
 * our typecheck about our code, the same seam `corbits-artifacts.d.ts` and
 * `corbits-providers.d.ts` use for the other bare-git corbitsdev packages.
 */
declare module "@corbits/mailbox" {
  import type { Hono } from "hono";

  export type MailboxDb = {
    execute: <T = unknown>(query: unknown) => Promise<T[]>;
  } & Record<string, unknown>;

  export type MailboxEventBus = Record<string, unknown>;

  export function createInMemoryMailboxEventBus(): MailboxEventBus;

  export type ResolvedPrincipal = { tenantId: string; principalId: string };

  export type OutgoingMailboxMessage = {
    raw: Uint8Array;
    from: string;
    to: string[];
    messageId: string;
  };

  export type MountMailboxOpts = {
    db: MailboxDb;
    bus: MailboxEventBus;
    resolvePrincipal: (ctx: unknown) => Promise<ResolvedPrincipal | null> | ResolvedPrincipal | null;
    senderAddressFor: (principal: ResolvedPrincipal) => Promise<string> | string;
    deliver: (message: OutgoingMailboxMessage) => Promise<void> | void;
    heartbeatIntervalMs?: number;
  };

  export function mountMailbox(app: Hono, opts: MountMailboxOpts): void;

  export function runMailboxMigrations(db: MailboxDb): Promise<void>;

  export type InboxItem = {
    tenantId: string;
    principalId: string;
    address: string;
    fromAddress: string;
    subject: string;
    body: string;
    source: string;
    externalId: string;
  };

  export type DeliveredInboxItem = { readonly item: InboxItem; readonly uid: number };

  export type DeliverInboxItemsOpts = {
    bus: MailboxEventBus;
    enqueue?: (delivered: DeliveredInboxItem) => void;
  };

  export function deliverInboxItems(
    db: MailboxDb,
    items: readonly InboxItem[],
    opts: DeliverInboxItemsOpts,
  ): Promise<DeliveredInboxItem[]>;

  export type WriteMailboxMessageArgs = {
    tenantId: string;
    principalId: string;
    address: string;
    fromAddress: string;
    subject: string;
    body: string;
    messageId?: string;
  };

  export function writeMailboxMessage(
    db: MailboxDb,
    args: WriteMailboxMessageArgs,
    bus: MailboxEventBus,
  ): Promise<{ messageId: string; uid: number }>;
}
