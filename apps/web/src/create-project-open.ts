/**
 * After the installer minted a tenant, open the ledger on that same
 * project id. A failed open conceals the tenant so a retry cannot mint a
 * new slug that leaves the failed one listed.
 */

export async function openCreatedProject<T>(args: {
  projectId: string;
  open: () => Promise<T>;
  conceal: (projectId: string) => Promise<void>;
  retryable?: (cause: unknown) => boolean;
}): Promise<T> {
  const retryable = args.retryable ?? (() => false);
  try {
    return await args.open();
  } catch (cause) {
    if (retryable(cause)) {
      try {
        return await args.open();
      } catch (retryCause) {
        await concealBestEffort(args.conceal, args.projectId);
        throw retryCause;
      }
    }
    await concealBestEffort(args.conceal, args.projectId);
    throw cause;
  }
}

async function concealBestEffort(
  conceal: (projectId: string) => Promise<void>,
  projectId: string,
): Promise<void> {
  try {
    await conceal(projectId);
  } catch (concealCause) {
    console.error("[projects] a failed creation left its project behind:", concealCause);
  }
}
