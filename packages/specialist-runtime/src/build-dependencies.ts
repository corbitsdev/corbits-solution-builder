/**
 * What a build does when the plan names something it cannot reach (CL-9963,
 * CL-9987). A worker once wrapped the plan's packages in fallbacks, briefed
 * its own critic not to flag them, and marked every task done; a later one
 * shipped an in-memory store that lost its data on restart. Stated once here
 * so the seeded AGENTS.md and a packet without it carry the same rule.
 */
export const BUILD_DEPENDENCIES_RULE = [
  `Install the packages, services and providers the plan names and use them directly: no dynamic import, no try/catch around an import, no fallback that stands in for one.`,
  ``,
  `Running on this machine is configuration, not a fallback. In development the application uses local instances of the services it uses in production: the same client and the same code, pointed at a local endpoint by environment variables. For Postgres, a local Postgres; when none is running, @electric-sql/pglite-socket serves one with nothing to install. For a model, a local OpenAI-compatible endpoint when one is available.`,
  ``,
  `One command (bun run dev, or the equivalent for the plan's runtime) starts the application and every local service it needs, with no account and no key. Before you call the build done, run that command, use the main flow against it, and say in your final message what you ran and what it returned.`,
  ``,
  `A key or service you cannot reach, and that has no local instance, is a blocker, never a reason to substitute a heuristic, a stub, an in-memory store or mock data. The application fails with a clear error that names what is missing. Record in QUESTIONS.md what it leaves unverified, and say so in your final message. A service needed only in production, such as a hosted file store, is a deploy step listed in the README, not a blocker.`,
  ``,
  `Tests may fake a service only at its network edge, so the application's real code runs. When the plan calls a model through @intx/inference, use its companions at the same version: @intx/inference-testing in the tests (its harness replaces fetch and scripts the provider's wire bytes, so the real call path runs with no key), and @intx/inference-catalog for model and provider names rather than ones you write by hand.`,
  ``,
  `This binds every brief you write for an agent you start: never tell one to fall back, and never tell a reviewer to overlook a substitute.`,
].join("\n");
