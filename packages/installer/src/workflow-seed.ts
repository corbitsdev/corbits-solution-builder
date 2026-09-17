/**
 * Seeds Solutions Builder's one workflow definition into the hub.
 *
 * The command ledger (`engine-ledger.ts`) keys its per-project session to this
 * row (`definitionIdFor(PROJECT_LIFECYCLE_ID)`); that is the only reason a
 * definition still needs to be registered here rather than through
 * `POST /workflows/deployments`, which the per-project lifecycle deployment
 * already uses.
 *
 * Idempotent by construction: the definition is keyed on its own wire hash, so
 * re-running seeds nothing when the generated definition has not changed, and
 * creates a new version when it has. A running instance keeps the version it
 * started on.
 */
import type { Transport } from "@intx/hub-client";
import { registerDefinition } from "./hub.js";
import type { WorkflowDefinition } from "@intx/workflow";
import { projectLifecycleDefinition, PROJECT_LIFECYCLE_ID } from "@solutions-builder/app/workflows/project-lifecycle";

/** SHA-256 over a string, hex-encoded. WebCrypto only, so no host import is needed for it. */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type SeededWorkflow = {
  readonly id: string;
  readonly name: string;
  readonly wireHash: string;
  readonly created: boolean;
};

/** The one definition row: the lifecycle anchor the command ledger's session keys on. */
function definitions(): { name: string; description: string; definition: WorkflowDefinition }[] {
  return [
    {
      name: PROJECT_LIFECYCLE_ID,
      description:
        "The nine human-gated stages, generated from the Solutions Builder transition ledger.",
      definition: projectLifecycleDefinition(),
    },
  ];
}

/**
 * What the package would deploy right now, without deploying it. Identity is
 * the wire hash, so comparing these ids against the tenant's rows says whether
 * the installed definition is current, missing or stale.
 */
export async function expectedWorkflowDefinitions(): Promise<{ name: string; id: string }[]> {
  const expected: { name: string; id: string }[] = [];
  for (const entry of definitions()) {
    const wireHash = await sha256(JSON.stringify(entry.definition));
    expected.push({ name: entry.name, id: `wfd_${wireHash.slice(0, 24)}` });
  }
  return expected;
}

export async function seedWorkflows(transport: Transport, tenantId: string): Promise<SeededWorkflow[]> {
  const seeded: SeededWorkflow[] = [];
  for (const entry of definitions()) {
    // The wire projection is what identity is keyed on upstream, so the hash is
    // taken over the definition exactly as it would be deployed.
    const wireHash = await sha256(JSON.stringify(entry.definition));
    const written = await registerDefinition(transport, tenantId, {
      id: `wfd_${wireHash.slice(0, 24)}`,
      name: entry.name,
      description: entry.description,
      wireHash,
    });
    seeded.push({ id: written.id, name: entry.name, wireHash, created: written.created });
  }

  return seeded;
}
