// Status vocabulary for the first-class workflow definition model, kept in its
// own workflow-scoped module.
export const workflowDefinitionStatuses = ["deployed", "stopped"] as const;
export type WorkflowDefinitionStatus =
  (typeof workflowDefinitionStatuses)[number];

export const workflowDefinitionVersionStatuses = [
  "active",
  "inactive",
  "failed",
] as const;
export type WorkflowDefinitionVersionStatus =
  (typeof workflowDefinitionVersionStatuses)[number];

import { type } from "arktype";

import { GrantRequirement } from "./grants";

const WorkflowDefinitionStatusType = type.enumerated(
  ...workflowDefinitionStatuses,
);
const WorkflowDefinitionVersionStatusType = type.enumerated(
  ...workflowDefinitionVersionStatuses,
);

// One entry in a definition's version history.
export const WorkflowDefinitionVersion = type({
  version: "string",
  status: WorkflowDefinitionVersionStatusType,
  createdAt: "string",
});

// The first-class workflow definition, as returned by the definition routes.
export const WorkflowDefinitionResponse = type({
  id: "string",
  tenantId: "string",
  name: "string",
  "description?": "string | null",
  currentVersion: "string",
  status: WorkflowDefinitionStatusType.describe(
    "Lifecycle state of the definition: `deployed` (a launchable version is active) or `stopped` (deactivated).",
  ),
  createdAt: "string",
  updatedAt: "string",
});

// Rollback a definition to a prior version.
export const WorkflowRollbackRequest = type({
  version: "string",
});

// Registers a definition row directly, for a caller that generated the row
// itself rather than deploying through the probe sidecar (`POST
// /workflows/deployments`). Identity is keyed on (name, wireHash): an
// unchanged wireHash under the same name is a no-op.
export const CreateWorkflowDefinition = type({
  "id?": "string",
  name: "string",
  "description?": "string",
  wireHash: "string",
  "grantRequirements?": GrantRequirement.array(),
});

export const CreateWorkflowDefinitionResponse = type({
  id: "string",
  created: "boolean",
});

export const WorkflowDeploymentStatus = type.enumerated(
  "deployed",
  "pending",
  "recovering",
  "releasing",
  "released",
  "failed",
  "destroy_failed",
);
export type WorkflowDeploymentStatus = typeof WorkflowDeploymentStatus.infer;

export const WorkflowDeploymentResponse = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: WorkflowDeploymentStatus.describe(
    "Deployment lifecycle status. `failed` is a terminal failure with no infrastructure. `destroy_failed` is a permanent cleanup failure where infrastructure may remain and require operator cleanup.",
  ),
  createdAt: "string",
});
export type WorkflowDeploymentResponse =
  typeof WorkflowDeploymentResponse.infer;
