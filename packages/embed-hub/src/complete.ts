import { createDependencies, runInference } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { createDB, listVisibleOfferings, resolveInferenceMaterials, resolveSourcesByOfferingIds } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import type { InferenceSource } from "@intx/types/runtime";
import { OPENAI_RESPONSES_PROVIDER } from "@corbits/openai-responses";

/** The catalog capability a plain chat completion needs (the installer's `CHAT_CAPABILITY`). */
const CHAT_CAPABILITY = "plain-text";

export type CompletionRequest = {
  readonly tenantId: string;
  readonly systemPrompt: string;
  readonly input: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
};

export type Completion = { readonly text: string; readonly provider: string; readonly model: string };

/** No chat offering in the tenant's catalog resolves to a credentialed source. */
export class NoInferenceSourceError extends Error {
  constructor(tenantId: string) {
    super(`tenant ${tenantId} has no chat offering with a usable credential`);
    this.name = "NoInferenceSourceError";
  }
}

/**
 * One inference call outside any run, on the tenant's default offering: the
 * chat-capable offering of lowest priority whose credential resolves, the
 * head of the chain a deploy would pin. The adapters are the sidecar's own
 * (the built-ins plus the Responses adapter), so a source that works for a
 * specialist works here.
 */
export function createCompletion(db: ReturnType<typeof createDB>["db"], credentialCipher: CredentialCipher) {
  let adapters: ReturnType<typeof loadAdapterRegistry> | undefined;
  const adapterRegistry = () =>
    (adapters ??= loadAdapterRegistry([
      { provider: OPENAI_RESPONSES_PROVIDER, specifier: import.meta.resolve("./responses-adapter.ts"), export: "createResponsesAdapter" },
    ]));

  async function defaultSource(tenantId: string): Promise<InferenceSource> {
    const offerings = (await listVisibleOfferings(db, tenantId))
      .filter((entry) => entry.offering.capabilities.includes(CHAT_CAPABILITY))
      .sort((a, b) => a.offering.priority - b.offering.priority || (a.offering.id < b.offering.id ? -1 : 1));
    for (const entry of offerings) {
      const resolved = await resolveSourcesByOfferingIds(db, tenantId, [entry.offering.id], credentialCipher);
      if (resolved.ok && resolved.sources[0]) return resolved.sources[0];
    }
    throw new NoInferenceSourceError(tenantId);
  }

  return async function complete(request: CompletionRequest): Promise<Completion> {
    const source = await defaultSource(request.tenantId);
    const [material] = await resolveInferenceMaterials(db, request.tenantId, [source.credentialId], credentialCipher);
    if (!material) throw new NoInferenceSourceError(request.tenantId);
    let seq = 0;
    const events = runInference({
      turns: [{ role: "user", content: [{ type: "text", text: request.input }], timestamp: Date.now() }],
      source,
      inferenceOptions: {
        systemPrompt: request.systemPrompt,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      },
      nextSeq: () => seq++,
      readMaterial: () => ({ secret: material.secret }),
      deps: createDependencies(await adapterRegistry()),
    });
    for await (const event of events) {
      if (event.type === "inference.error") throw new Error(`${source.provider} ${source.model}: ${event.data.error.message}`);
      if (event.type === "inference.done") {
        const text = event.data.turn.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
        return { text, provider: source.provider, model: source.model };
      }
    }
    throw new Error(`${source.provider} ${source.model} ended without a reply`);
  };
}
