/**
 * One key per hub resource. Every query and every invalidation names its
 * data through here, so a key is spelled once and a prefix match
 * (`invalidateQueries({ queryKey: keys.tenant.all })`) reaches every
 * instance of that resource.
 */
export const keys = {
  /** The shell's one read: host status, providers, decisions, projects and the workspace tenant. */
  home: ["home"] as const,
  me: ["me"] as const,
  memberships: ["memberships"] as const,
  tenant: {
    all: ["tenant"] as const,
    of: (id: string) => ["tenant", id] as const,
  },
  tenants: {
    all: ["tenants"] as const,
    under: (parentId: string) => ["tenants", parentId] as const,
  },
  deployments: {
    all: ["deployments"] as const,
    of: (tenantId: string) => ["deployments", tenantId] as const,
  },
  approvals: {
    all: ["approvals"] as const,
    of: (tenantId: string) => ["approvals", tenantId] as const,
    delivery: (tenantId: string, projectId: string) => ["approvals", tenantId, "delivery", projectId] as const,
  },
  workflowRef: {
    all: ["workflowRef"] as const,
    of: (projectId: string) => ["workflowRef", projectId] as const,
  },
  workflowView: {
    all: ["workflowView"] as const,
    of: (projectId: string) => ["workflowView", projectId] as const,
    /** A project card's raw read: a run that has not written its first state reports stage 0, which the workspace's own entry never holds. */
    card: (projectId: string) => ["workflowView", projectId, "card"] as const,
  },
  runEvents: {
    all: ["runEvents"] as const,
    of: (tenantId: string, deploymentId: string, runId: string) => ["runEvents", tenantId, deploymentId, runId] as const,
  },
  projectView: {
    all: ["projectView"] as const,
    of: (projectId: string) => ["projectView", projectId] as const,
  },
  projectOpening: {
    of: (projectId: string) => ["projectOpening", projectId] as const,
  },
  projects: ["projects"] as const,
  decisions: ["decisions"] as const,
  thread: {
    all: ["thread"] as const,
    in: (tenantId: string) => ["thread", tenantId] as const,
    of: (tenantId: string, addresses: readonly string[]) => ["thread", tenantId, [...addresses].sort()] as const,
  },
  stageAgent: {
    all: ["stageAgent"] as const,
    of: (projectId: string, stage: number) => ["stageAgent", projectId, stage] as const,
    status: (projectId: string, stage: number) => ["stageAgent", projectId, stage, "status"] as const,
    addresses: (projectId: string, stage: number, live: string) => ["stageAgent", projectId, stage, "addresses", live] as const,
    run: (projectId: string, stage: number, live: string) => ["stageAgent", projectId, stage, "run", live] as const,
  },
  buildAttempts: {
    of: (projectId: string) => ["buildAttempts", projectId] as const,
    log: (projectId: string, attempt: number) => ["buildAttempts", projectId, attempt, "log"] as const,
  },
  activeModel: {
    all: ["activeModel"] as const,
    of: (projectId?: string, stage?: number) => ["activeModel", projectId ?? null, stage ?? null] as const,
  },
  providers: ["providers"] as const,
  resolvedCatalog: ["resolvedCatalog"] as const,
  /** The newest artifact a drafting stage's specialist wrote, by kind. */
  stageWork: {
    all: ["stageWork"] as const,
    of: (tenantId: string, kind: string) => ["stageWork", tenantId, kind] as const,
  },
  /** A document's sha256, computed in the browser. */
  contentDigest: {
    of: (content: string) => ["contentDigest", content] as const,
  },
  artifact: {
    all: ["artifact"] as const,
    of: (tenantId: string, id: string) => ["artifact", tenantId, id] as const,
  },
  approvedChain: {
    all: ["approvedChain"] as const,
    of: (tenantId: string, stage: number, nodeIds: readonly string[]) => ["approvedChain", tenantId, stage, [...nodeIds]] as const,
  },
  designerSettings: ["designerSettings"] as const,
  deckDesigns: ["deckDesigns"] as const,
  googleDrive: ["googleDrive"] as const,
  evaluation: {
    all: ["evaluation"] as const,
    of: (projectId: string, tag: string) => ["evaluation", projectId, tag] as const,
  },
  classifier: {
    all: ["classifier"] as const,
  },
  evaluatorNotes: {
    all: ["evaluatorNotes"] as const,
    of: (subject: string) => ["evaluatorNotes", subject] as const,
  },
  stakeholders: {
    all: ["stakeholders"] as const,
    of: (projectId: string) => ["stakeholders", projectId] as const,
  },
} as const;
