/**
 * What a build does when the plan names something it cannot reach (CL-9963).
 * A worker once wrapped the plan's packages in fallbacks, briefed its own
 * critic not to flag them, and marked every task done. Stated once here so
 * the host's build packet and the seeded AGENTS.md carry the same rule.
 */
export const BUILD_DEPENDENCIES_RULE = [
  `Install the packages, services and providers the plan names and use them directly: no dynamic import, no try/catch around an import, no fallback that stands in for one.`,
  ``,
  `A package, service or key you cannot reach is a blocker, not a reason to substitute a heuristic, a stub, a local file or mock data. Record it in QUESTIONS.md, mark every task that depends on it not done in STATUS.md, and say so in your final message.`,
  ``,
  `The application you ship has no fallback either: run without a key or service it needs, it fails with a clear error that names what is missing, and never serves a substitute in its place, documented or not.`,
  ``,
  `This binds every brief you write for an agent you start: never tell one to fall back, and never tell a reviewer to overlook a substitute.`,
].join("\n");
