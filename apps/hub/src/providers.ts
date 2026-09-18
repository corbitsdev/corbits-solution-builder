/**
 * Inference connections — read side.
 *
 * Connecting, reordering, selecting a model and disconnecting are now the
 * client's job: it talks to Interchange's own catalog (`provider`,
 * `credential`, `model_provider`, `model`, `model_offering`) directly over
 * `/hub`. This module keeps only what `GET /api/status` still needs to read:
 * which providers are connected and which one is active.
 */
import { listCatalogProviders, type CatalogProviderRow, type CatalogModelRow } from "./catalog.js";

export type ProviderCapabilities = {
  text: boolean;
  tools: boolean;
  streaming: boolean;
  /** Unknown is unknown. It is never rendered as "supported". */
  structuredOutput: "supported" | "unsupported" | "unknown";
};

export type ProviderSummary = {
  id: string;
  providerId: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  status: string;
  statusDetail: string | null;
  models: string[];
  capabilities: ProviderCapabilities;
  active: boolean;
  /** Preference order, lowest first. */
  priority: number;
  validatedAt: Date | null;
  /** The operator's chosen model, or null to let the host pick. */
  selectedModel: string | null;
  /** Present so the UI can say "connected" without ever seeing the secret. */
  hasCredential: boolean;
};

function summarizeCapabilities(models: CatalogModelRow[]): ProviderCapabilities {
  const all = new Set(models.flatMap((entry) => entry.capabilities));
  return {
    text: all.has("plain-text"),
    tools: all.has("function-calling"),
    streaming: all.has("plain-text-streaming"),
    structuredOutput: all.has("structured-output") ? "supported" : "unknown",
  };
}

function selectedModelOf(models: CatalogModelRow[]): string | null {
  const enabled = models.filter((entry) => !entry.disabled);
  return enabled.length > 0 && enabled.length < models.length ? enabled[0]!.canonicalName : null;
}

function catalogToSummary(row: CatalogProviderRow): ProviderSummary {
  return {
    id: row.providerRowId,
    providerId: row.providerId,
    label: row.label,
    kind: row.kind === "local" ? "local_endpoint" : row.kind,
    baseUrl: row.baseUrl || null,
    status: row.status,
    statusDetail: null,
    models: row.models.map((entry) => entry.canonicalName),
    capabilities: summarizeCapabilities(row.models),
    active: true,
    priority: row.basePriority,
    validatedAt: row.validatedAt,
    selectedModel: selectedModelOf(row.models),
    hasCredential: row.kind !== "local",
  };
}

export async function listProviders(): Promise<ProviderSummary[]> {
  const catalogRows = await listCatalogProviders();
  return catalogRows.map(catalogToSummary).sort((a, b) => a.priority - b.priority);
}
