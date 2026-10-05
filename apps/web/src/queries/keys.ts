/**
 * One key per hub resource. Every query and every invalidation names its
 * data through here, so a key is spelled once and a prefix match
 * (`invalidateQueries({ queryKey: keys.tenant.all })`) reaches every
 * instance of that resource.
 */
export const keys = {
  me: ["me"] as const,
  memberships: ["memberships"] as const,
  status: ["status"] as const,
  workspaceTenantId: ["workspaceTenantId"] as const,
  buildWorker: ["buildWorker"] as const,
  buildAttempts: {
    all: ["buildAttempts"] as const,
    of: (projectId: string) => ["buildAttempts", projectId] as const,
  },
  buildAttempt: {
    all: ["buildAttempt"] as const,
    of: (projectId: string, attempt: number) => ["buildAttempt", projectId, attempt] as const,
  },
  languageSettings: ["languageSettings"] as const,
  projectOpening: {
    all: ["projectOpening"] as const,
    of: (projectId: string) => ["projectOpening", projectId] as const,
  },
  specialistRun: {
    all: ["specialistRun"] as const,
    of: (projectId: string, stage: number) => ["specialistRun", projectId, stage] as const,
  },
  stageAgentAddresses: {
    all: ["stageAgentAddresses"] as const,
    of: (projectId: string, stage: number) => ["stageAgentAddresses", projectId, stage] as const,
  },
  designDocuments: {
    all: ["designDocuments"] as const,
    of: (scope: string) => ["designDocuments", scope] as const,
  },
  projectDeckSettings: {
    all: ["projectDeckSettings"] as const,
    of: (projectId: string) => ["projectDeckSettings", projectId] as const,
  },
  projectInfo: {
    all: ["projectInfo"] as const,
    of: (projectId: string) => ["projectInfo", projectId] as const,
  },
  deckBrief: {
    all: ["deckBrief"] as const,
    of: (projectId: string, role: string) => ["deckBrief", projectId, role] as const,
  },
  designFeedback: {
    all: ["designFeedback"] as const,
    of: (tenantId: string, nodeId: string) => ["designFeedback", tenantId, nodeId] as const,
  },
  /** Whose move a project card shows (`displayTurn`), composed from the stage's thread and specialist status. */
  turn: {
    all: ["turn"] as const,
    of: (projectId: string, stage: number) => ["turn", projectId, stage] as const,
  },
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
  projects: ["projects"] as const,
  decisions: ["decisions"] as const,
  thread: {
    all: ["thread"] as const,
    of: (tenantId: string, addresses: readonly string[]) => ["thread", tenantId, [...addresses].sort()] as const,
  },
  stageAgent: {
    all: ["stageAgent"] as const,
    of: (projectId: string, stage: number) => ["stageAgent", projectId, stage] as const,
  },
  activeModel: {
    all: ["activeModel"] as const,
    of: (projectId?: string, stage?: number) => ["activeModel", projectId ?? null, stage ?? null] as const,
  },
  providers: ["providers"] as const,
  resolvedCatalog: ["resolvedCatalog"] as const,
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
  stakeholders: {
    all: ["stakeholders"] as const,
    of: (projectId: string) => ["stakeholders", projectId] as const,
  },
} as const;
