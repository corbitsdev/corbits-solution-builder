/**
 * The compatibility matrix, as rows — BUILD_PLAN_V3 §4.
 *
 * §4 asks for exact revision, version, evidence, limitations and a
 * classification per launch dependency, with status "verified, unavailable, or
 * planned-only". A matrix kept in a document is a matrix nobody re-checks, and
 * the classification is what has teeth: a launch-required dependency that is
 * only planned blocks the gate depending on it.
 *
 * Recorded from what this build actually did. Where something was tried and
 * did not work, that is what the row says — §4 is explicit that a gap is
 * scoped work, not a fake substitute.
 */
import { database } from "../db/client.js";
import { HUB_MIGRATIONS } from "../hub/migrations.generated.js";
import * as table from "../db/schema.js";

type Row = {
  dependency: string;
  classification: "launch-required" | "optional" | "builder-owned";
  status: "verified" | "unavailable" | "planned-only";
  revision?: string;
  version?: string;
  evidence: string;
  limitations: string[];
};

/** What this build has actually established, one row per dependency. */
export function knownCompatibility(): Row[] {
  return [
    {
      dependency: "@intx/* (Interchange)",
      classification: "launch-required",
      status: "verified",
      revision: "e2fa7e81",
      evidence:
        `Vendored from origin/main and mounted in-process on pglite; ${HUB_MIGRATIONS.length} migrations apply and smoke:hub proves both embedded and hosted topologies.`,
      limitations: [
        "One patch carried against upstream: createDB accepts an existing handle (vendor/interchange/PATCHES.md).",
      ],
    },
    {
      dependency: "@corbits/artifacts",
      classification: "launch-required",
      status: "verified",
      evidence:
        "Adopted for artifact bytes and versions; its acceptance suite runs against a pglite-backed host (Gate 2 spike).",
      limitations: [
        "Needs a postgres-js result shape on pglite; the host applies that shim and the fix is filed upstream.",
      ],
    },
    {
      dependency: "@corbits/oauth-core, codex-provider, xai-provider, openai-responses",
      classification: "optional",
      status: "verified",
      evidence: "Real PKCE S256 loopback sign-in for Codex and xAI; smoke:oauth covers the lifecycle.",
      limitations: [
        "Codex reports no usage or quota, so cost for it is stated as unknown rather than zero.",
      ],
    },
    {
      dependency: "@corbits/react-ui",
      classification: "optional",
      status: "verified",
      evidence:
        "Installed from git with trustedDependencies so its prepare hook builds dist; the shell, chat and tables render from it.",
      limitations: ["--input is declared identically in light and dark upstream; corrected locally."],
    },
    {
      dependency: "@corbits/code (shared-hub multi-agent build)",
      classification: "launch-required",
      status: "unavailable",
      revision: "6ea5969",
      evidence:
        "Read at corbitsdev/corbits-code HEAD (v0.3.18), not inferred from its absence here. It is a CLI: `bin` exposes one binary and `exports` is empty, so there is no library surface to import. It has an internal agent fleet, but nothing publishes it — the only HTTP servers in the tree are the OAuth and MCP callback listeners, so there is no daemon or API an external supervisor could attach to. Stage 8 therefore runs through the bounded local bridge, which proves prompt, final text and exit status only.",
      limitations: [
        "`--resume` throws `only available in interactive mode` when the command is `exec` (src/config/index.ts), so a supervised run cannot be resumed.",
        "`exec` emits no normalized event stream and returns no session id, so there is nothing to subscribe to or steer.",
        "Blocks Gate 7 and full acceptance: roster, per-agent grants, steering, interrupt and checkpoint resume have no surface to bind to, not merely no integration.",
        "Closing this is upstream work in corbits-code — a session-control API — not wiring in this repo. The bridge is honest about what it does and must be retired once that exists.",
      ],
    },
    {
      dependency: "Native workers and signing (macOS, Windows)",
      classification: "launch-required",
      status: "unavailable",
      evidence:
        "Signing needs an Apple Developer ID certificate and an Apple ID for notarization; Windows needs an Authenticode certificate. Neither credential exists for this build, so the app is ad-hoc signed. This is a credential this repository cannot mint, not an unwritten step.",
      limitations: [
        "Scenario B's targets cannot be claimed until a machine with those certificates produces install receipts.",
        "An ad-hoc signed build runs locally and is fine for a walkthrough; it is not something to hand someone as a download.",
      ],
    },
  ];
}

/** Idempotent: the matrix is rewritten to what is currently true. */
export async function recordCompatibility(): Promise<number> {
  const { db } = database();
  for (const row of knownCompatibility()) {
    await db
      .insert(table.compatibilityRecord)
      .values({
        dependency: row.dependency,
        classification: row.classification,
        status: row.status,
        revision: row.revision ?? null,
        version: row.version ?? null,
        evidence: row.evidence,
        limitations: row.limitations,
        checkedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: table.compatibilityRecord.dependency,
        set: {
          classification: row.classification,
          status: row.status,
          revision: row.revision ?? null,
          version: row.version ?? null,
          evidence: row.evidence,
          limitations: row.limitations,
          checkedAt: new Date(),
        },
      });
  }
  return knownCompatibility().length;
}
