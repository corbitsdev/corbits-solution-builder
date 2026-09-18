/**
 * An allocated sidecar is a child process of the host that placed it, and
 * stopping the host stops them all. On the next start the reconciler waits
 * its full connect timeout for each one to dial back in before it gives the
 * allocation up, and every command on that deployment waits with it. When
 * the process is gone the wait is pointless, so its deadline is moved to the
 * past and the reconciler releases the allocation on its next pass; the
 * deployment reads as released, and the lifecycle is deployed again on
 * first use. An allocation bound to another hub address is left alone: the
 * reconciler will not act on it, and `workflow-deploy.ts` steps around it.
 */
type AllocationRow = {
  readonly id: string;
  readonly status: string;
  readonly generation: number;
  readonly provisionerBindingFingerprint: string;
  readonly externalRef?: string;
};
type AllocationStore = {
  listActive(): Promise<AllocationRow[]>;
  markConnectionLost(args: {
    allocationId: string;
    generation: number;
    connectDeadline: Date;
    now: Date;
  }): Promise<unknown>;
};

export async function retireDeadSidecars(untyped: unknown, bindingFingerprint: string): Promise<void> {
  // The typecheck stub of the platform's store package has no method types.
  const store = untyped as AllocationStore;
  const now = new Date();
  for (const allocation of await store.listActive()) {
    if (allocation.status !== "allocated") continue;
    if (allocation.provisionerBindingFingerprint !== bindingFingerprint) continue;
    if (processAlive(allocation.externalRef)) continue;
    await store.markConnectionLost({
      allocationId: allocation.id,
      generation: allocation.generation,
      connectDeadline: new Date(0),
      now,
    });
  }
}

/** The process provisioner's external ref is `<allocation>:<generation>:<pid>`. */
export function processAlive(externalRef: string | undefined): boolean {
  const pid = Number(externalRef?.split(":").at(-1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
