/**
 * The inference port.
 *
 * Every provider attempt — Anthropic Messages, the OpenAI-style chat
 * completions that OpenAI, OpenRouter and local Ollama endpoints all speak —
 * runs through Interchange's `runInference` harness: request building,
 * response parsing, retries and timeouts are the platform's, not this file's.
 * Domain code never reaches past this file, and this file contains no gate
 * policy — the boundary the plan draws in section 3.
 *
 * `runInference` runs exactly one provider per call; there is no
 * cross-provider failover inside it. That failover — trying the operator's
 * providers in order, aggregating refusals — is `complete()`'s job below.
 */
import { runInference } from "@intx/inference";
import { createDefaultDependencies } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";
import { HostError, ReplyCutShort } from "./errors.js";
import {
  catalogEntry,
  credentialFor,
  providerOrder,
  type ProviderSummary,
} from "./providers.js";
import { describeInferenceFailure } from "./failure.js";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth.js";
import { callResponses } from "./responses.js";
import { recordHostUsage } from "./spend.js";

export type CompletionRequest = {
  readonly system: string;
  readonly prompt: string;
  /** Whose spend this call is, and what for; a call without it is not recorded. */
  readonly usage?: { readonly projectId: string; readonly purpose: string };
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * A stage artifact is a long document, and a local model on ordinary hardware
   * is slow. The default is generous on purpose: a timeout here is reported as
   * a provider failure and the draft is lost, so cutting a working generation
   * short is worse than waiting.
   */
  readonly timeoutMs?: number;
  /** Everything written so far, on each token. For showing a draft as it forms. */
  readonly onText?: (text: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export type CompletionResult = {
  readonly text: string;
  readonly providerId: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

/**
 * Which model to use.
 *
 * The operator's explicit choice always wins. Otherwise the pick is made over
 * the *discovered* catalogue by rank and version, never by naming specific
 * model ids — a hardcoded id is stale the week it is written, and every
 * provider here reports what it actually serves.
 */

/** Models that cannot draft a document, whatever their version. */
const NOT_A_DRAFTER = /embed|vision|whisper|tts|moderation|rerank|image|audio|search|research/i;

/** Family rank within one provider's catalogue: higher wins. */
function familyRank(model: string): number {
  const name = model.toLowerCase();
  if (name.includes("opus")) return 4;
  if (name.includes("pro")) return 4;
  if (name.includes("sonnet")) return 3;
  if (name.includes("fable")) return 3;
  // A "mini", "instant", "fast" or "haiku" is the cheap tier: usable, but not
  // the default for work whose output a human is asked to approve.
  if (/mini|instant|fast|haiku|lite|flash/.test(name)) return 1;
  return 2;
}

/**
 * The version numbers in a model id, most significant first. `gpt-5.6-sol`
 * yields [5, 6]; `claude-opus-5` yields [5]. Comparing these is what keeps the
 * choice current without naming anything.
 */
function versionOf(model: string): number[] {
  const match = model.match(/(\d+(?:[._]\d+)*)/g);
  if (!match) return [0];
  return match
    .join(".")
    .split(/[._]/)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function chooseModel(provider: ProviderSummary): string {
  if (provider.selectedModel) return provider.selectedModel;

  const usable = provider.models.filter((model) => !NOT_A_DRAFTER.test(model));
  const ranked = [...usable].sort((left, right) => {
    const byFamily = familyRank(right) - familyRank(left);
    if (byFamily !== 0) return byFamily;
    return compareVersions(versionOf(left), versionOf(right));
  });

  return ranked[0] ?? provider.models[0] ?? "unknown";
}

/**
 * The message shown when every provider refused.
 *
 * Exported so the failure gate asserts against the message the product
 * actually produces rather than against a copy of it.
 */
export function aggregateRefusal(refusals: readonly { reason: string }[]): string {
  return (
    `None of your ${refusals.length} providers could draft this.\n\n` +
    refusals.map((entry, index) => `${index + 1}. ${entry.reason}`).join("\n")
  );
}

export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const result = await completeUnrecorded(request);
  if (request.usage) {
    await recordHostUsage({
      projectId: request.usage.projectId,
      purpose: request.usage.purpose,
      provider: result.providerId,
      model: result.model,
      tokens:
        result.inputTokens !== null && result.outputTokens !== null
          ? { input: result.inputTokens, output: result.outputTokens, cacheRead: 0, cacheWrite: 0, thinking: 0 }
          : null,
    }).catch((cause: unknown) => console.error("[spend] a host call's usage could not be recorded", cause));
  }
  return result;
}

async function completeUnrecorded(request: CompletionRequest): Promise<CompletionResult> {
  // Providers are tried in the operator's order. Moving down the list happens
  // only when the one above refuses, and the result records which provider
  // actually answered — a switch shows up in the artifact's provenance rather
  // than happening quietly behind it.
  const order = await providerOrder();
  if (order.length === 0) {
    throw new HostError(
      "provider_unavailable",
      "No inference connection is ready. Connect a provider in Settings.",
    );
  }

  const refusals: { label: string; reason: string }[] = [];

  for (const candidate of order) {
    try {
      return await completeWith(candidate, request);
    } catch (cause) {
      // Only a provider-side refusal moves to the next one. A validation error
      // or a cancelled request would fail identically everywhere.
      const retryElsewhere =
        cause instanceof HostError &&
        (cause.code === "provider_unavailable" || cause.code === "not_authorized");
      if (!retryElsewhere) throw cause;

      refusals.push({
        label: candidate.label,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Reporting only the last refusal is how "it tried three providers" reads as
  // "it went straight to the third one". Every provider that was asked is
  // named, in the order they were asked.
  if (refusals.length === 1) {
    const only = refusals[0]!;
    const error = new HostError("provider_unavailable", only.reason, {}, true);
    error.remediation = { kind: "switch_provider", label: "Connect another provider" };
    throw error;
  }

  const error = new HostError("provider_unavailable", aggregateRefusal(refusals), { refusals }, true);
  error.remediation = { kind: "switch_provider", label: "Connect another provider" };
  throw error;
}

/**
 * Runtime dependencies for the harness: `globalThis.fetch` and the
 * production scheduler, bound to the built-in adapter registry
 * (`anthropic`, `openai`, `openai-compatible`, `google-genai`). One instance
 * for the process — it holds no per-call state.
 */
const deps = createDefaultDependencies();

async function completeWith(
  provider: ProviderSummary,
  request: CompletionRequest,
): Promise<CompletionResult> {
  const model = chooseModel(provider);

  // OAuth providers speak the Responses protocol with their own wire quirks.
  if ((OAUTH_PROVIDERS as readonly string[]).includes(provider.providerId)) {
    const result = await callResponses({
      providerId: provider.providerId as OAuthProviderId,
      model,
      system: request.system,
      prompt: request.prompt,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { ...result, providerId: provider.providerId, model };
  }

  const secret = await credentialFor(provider);
  // A local endpoint legitimately has no credential; every other kind needs
  // one to authenticate at all.
  if (!secret && provider.kind !== "local_endpoint") {
    throw new HostError("not_authorized", `The ${provider.label} credential is missing.`);
  }

  const source: InferenceSource = {
    id: provider.id,
    provider:
      provider.providerId === "anthropic"
        ? "anthropic"
        : provider.providerId === "openai"
          ? "openai"
          : "openai-compatible",
    baseURL: inferenceBaseURL(provider),
    // Opaque under this scheme — `readMaterial` below ignores it and closes
    // over the secret this call already resolved, since there is exactly one
    // credential per attempt and no cell of our own to key it against.
    credentialId: provider.id,
    model,
  };

  // Anthropic has deprecated `temperature` on its current models, so it is
  // never sent there; every specialist carries one, and sending it cost a
  // refused call per model per launch. Other models may reject it too: the
  // first refusal naming the parameter drops it and is remembered for the
  // life of the process, so the cost is one wasted call.
  const withoutTemperature =
    provider.providerId === "anthropic" || rejectsTemperature.has(`${provider.id}:${model}`);
  try {
    return await attempt(withoutTemperature);
  } catch (cause) {
    if (withoutTemperature || !retriesWithoutTemperature(cause)) throw cause;
    rejectsTemperature.add(`${provider.id}:${model}`);
    return await attempt(true);
  }

  async function attempt(dropTemperature: boolean): Promise<CompletionResult> {
  let seq = 0;
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for await (const event of runInference({
    turns: [
      { role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() },
    ],
    source,
    inferenceOptions: {
      systemPrompt: request.system,
      maxTokens: request.maxTokens ?? 4096,
      ...(!dropTemperature && typeof request.temperature === "number"
        ? { temperature: request.temperature }
        : {}),
      totalTimeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    readMaterial: () => ({ secret: secret ?? "" }),
    deps,
    nextSeq: () => seq++,
  })) {
    if (event.type === "inference.error") {
      const failure = describeInferenceFailure({
        providerLabel: provider.label,
        providerId: provider.providerId,
        error: event.data.error,
      });
      const error = new HostError(failure.code, failure.message, {}, failure.retryable);
      if (failure.remediation) error.remediation = failure.remediation;
      throw error;
    }
    if (event.type === "inference.text.delta") {
      request.onText?.(event.data.partial.text);
    }
    if (event.type === "inference.done") {
      text = event.data.turn.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      inputTokens = event.data.usage.input;
      outputTokens = event.data.usage.output;
    }
  }

  // A model that used every token it was allowed stopped mid-sentence, and a
  // draft cut short is not a draft. Said here, once, rather than stored and
  // discovered when the document fails to render.
  const limit = request.maxTokens ?? 4096;
  if (outputTokens !== null && outputTokens >= limit) {
    throw new ReplyCutShort(
      `${provider.label} stopped at its output limit of ${limit} tokens, so the reply is cut short and nothing was recorded.`,
      limit,
    );
  }

  return { text, providerId: provider.providerId, model, inputTokens, outputTokens };
  }
}

/**
 * Models that answered a request carrying `temperature` with a refusal naming
 * it. Keyed by provider and model, remembered for the life of the process.
 */
const rejectsTemperature = new Set<string>();

/**
 * Whether a provider's refusal is about the `temperature` parameter itself.
 *
 * Exported so the failure gate asserts against the predicate the product uses
 * rather than a copy of it.
 */
export function retriesWithoutTemperature(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /temperature/i.test(message);
}

/**
 * The origin `runInference`'s adapters build their relative request paths
 * against (e.g. Anthropic's adapter emits `/v1/messages`, OpenAI's emits
 * `/chat/completions`) — not the `/models`-probing base this host stores for
 * connection validation, which already carries a version suffix for some
 * providers and none for others.
 *
 * A local endpoint is the one case an operator can type without `/v1`; every
 * other provider's stored base URL already matches what its adapter expects.
 */
function inferenceBaseURL(provider: ProviderSummary): string {
  if (provider.providerId === "anthropic") return "https://api.anthropic.com";
  const base = provider.baseUrl ?? catalogEntry(provider.providerId)?.baseUrl ?? "";
  if (provider.kind !== "local_endpoint") return base;
  const root = base.replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}
