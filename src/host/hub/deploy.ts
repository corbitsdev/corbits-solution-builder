/**
 * A definition's body, committed to the hub's own registry.
 *
 * The `workflow_definition` row says a stage exists and what it may do. What
 * the specialist actually reads — the system prompt — is not on that row by
 * design: the platform keeps it in a git repo the hub itself hosts, one per
 * definition, committed on the deploy ref. `createDeployPack` is how a sidecar
 * later pulls it.
 *
 * We had been writing the row and keeping the prompt in a table of our own,
 * which meant the platform could not answer "what does stage 1 tell its
 * agent?" without asking us. It can now.
 */
import { hub } from "./mount.js";

export type DeployedBody = {
  readonly definitionId: string;
  readonly commitSha: string;
};

/**
 * Commits one system prompt per definition.
 *
 * Content-addressed by git, so re-running with an unchanged prompt produces
 * the same tree; the store commits regardless, and the sha is what tells the
 * two apart.
 */
export async function deployDefinitionBodies(
  bodies: readonly { definitionId: string; systemPrompt: string }[],
): Promise<DeployedBody[]> {
  const store = hub().agentRepoStore;
  const written: DeployedBody[] = [];
  for (const body of bodies) {
    // Serialized deliberately: the store's contract is that the caller does
    // not write two commits to one agent's repo concurrently.
    const { commitSha } = await store.writeDeployTree(body.definitionId, {
      systemPrompt: body.systemPrompt,
    });
    written.push({ definitionId: body.definitionId, commitSha });
  }
  return written;
}

/**
 * The packfile a sidecar would pull for this definition.
 *
 * The store exposes no read-the-tree call, so this is how a caller proves the
 * body is really in the repo rather than trusting that the write returned.
 */
export async function deployedPack(
  definitionId: string,
): Promise<{ bytes: number; commitSha: string; ref: string } | null> {
  const store = hub().agentRepoStore;
  const pack = await store.createDeployPack(definitionId).catch(() => null);
  return pack ? { bytes: pack.pack.length, commitSha: pack.commitSha, ref: pack.ref } : null;
}
