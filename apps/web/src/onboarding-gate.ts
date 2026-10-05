/**
 * Whether the shell shows onboarding instead of the app (#754).
 *
 * Inference is required, so no provider ready means onboarding whatever
 * else is true. The first-project step is for an app with nothing to work
 * on: it is never shown over a project the person has open, and a poll
 * that could not read the project list says nothing about how many there
 * are.
 */
export function shouldShowOnboarding(input: { readonly inferenceConnected: boolean; readonly projectCount: number; readonly skippedSetup: boolean; readonly inProject: boolean }): boolean {
  if (!input.inferenceConnected) return true;
  if (input.inProject) return false;
  return input.projectCount === 0 && !input.skippedSetup;
}

/**
 * A read the hub refused because the workspace is not installed yet, or
 * not installed again after a restart, keeps what the app already holds
 * (#754): null here means "keep", and any other failure is rethrown.
 */
export function keepUntilInstalled(cause: unknown, isInstallConflict: (cause: unknown) => boolean): null {
  if (isInstallConflict(cause)) return null;
  throw cause;
}
