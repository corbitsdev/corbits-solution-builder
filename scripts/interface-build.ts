/**
 * What the interface needs on disk before Vite runs.
 *
 * `bun run ui:build` is more than a Vite build: the closure tarballs and the
 * compiled project-workflow entries are written into `apps/web/public/`
 * first, by the `bun run` steps that script names ahead of `vite build`.
 * The development launcher builds the interface itself, and once built it
 * with Vite alone, so a fresh checkout served an interface that could not
 * start a project's workflow. The steps are read from `package.json` here
 * rather than listed a second time, so the launcher and the build cannot
 * drift apart again.
 */

/** The `bun run` script names `uiBuildScript` runs before its Vite build, in order. */
export function interfacePackSteps(uiBuildScript: string): string[] {
  const steps: string[] = [];
  for (const step of uiBuildScript.split("&&").map((part) => part.trim())) {
    if (step.startsWith("vite ")) break;
    if (step.startsWith("bun run ")) steps.push(step.slice("bun run ".length));
  }
  return steps;
}
