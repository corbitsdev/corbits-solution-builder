/**
 * OAuth-provider inference, through Interchange's own adapter contract.
 *
 * `@corbits/xai-provider` and `@corbits/codex-provider` export
 * `AdapterFactory`s — the exact `@intx/inference` contract — carrying each
 * backend's wire quirks: path, required headers, system-prompt placement,
 * content shape, and which standard fields the backend rejects. Those stay
 * exactly where they are: OAuth against a model vendor is this host's own
 * concern, not something the platform's provider catalogue knows about.
 *
 * What moved to the platform is the driving loop. This file no longer builds
 * a request, sends it, or parses SSE itself — it hands the adapter to
 * `runInference` (wrapping it in a single-adapter registry, since the
 * built-in registry only knows `anthropic`/`openai`/`google-genai`) and reads
 * the harness's events back, the same as every other provider now gets
 * retries and timeouts from the platform rather than from a second copy of
 * that logic here.
 */
import { runInference, createDependencies, type AdapterRegistry } from "@intx/inference";
import type { InferenceSource } from "@intx/types/runtime";
import {
  createXaiResponsesAdapter,
  xaiUserIdFromAccessToken,
  XAI_SESSION_ID_OPTION,
  XAI_USER_ID_OPTION,
} from "@corbits/xai-provider";
import {
  createCodexResponsesAdapter,
  parseCodexQuirks,
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_SESSION_ID_OPTION,
} from "@corbits/codex-provider";
import { HostError } from "./errors.js";
import { accessTokenFor, DEFINITIONS, type OAuthProviderId } from "./oauth.js";
import { describeInferenceFailure } from "./failure.js";

export type ResponsesResult = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * Codex's quirks bag carries host identity the package refuses to default —
 * "there is no honest generic product name", as it puts it. These are this
 * app's own values, and they are what the backend sees.
 */
function codexQuirks(): unknown {
  return parseCodexQuirks({
    productName: "Solutions Builder",
    environmentTagName: "solutions_builder",
  });
}

/**
 * A registry of exactly one adapter, keyed to the OAuth provider being
 * called. `runInference`'s `deps.adapters` is a general-purpose registry
 * interface; a single-entry one is a legitimate implementation of it; there
 * is nothing to gain by hand-rolling `createAdapterRegistry`'s tiny `Map`
 * wrapper here for a set of adapters that never grows past one.
 */
function registryFor(providerId: OAuthProviderId): AdapterRegistry {
  return {
    has: (candidate) => candidate === providerId,
    resolve: (source) =>
      providerId === "codex-oauth"
        ? createCodexResponsesAdapter(source, codexQuirks())
        : createXaiResponsesAdapter(source),
  };
}

export async function callResponses(args: {
  providerId: OAuthProviderId;
  model: string;
  system: string;
  prompt: string;
  timeoutMs: number;
}): Promise<ResponsesResult> {
  const definition = DEFINITIONS[args.providerId];
  const tokens = await accessTokenFor(args.providerId);

  // Each adapter reads the identity it needs out of `providerOptions` under a
  // key the package names. Supplying them by the packages' own constants means
  // a rename upstream is a compile error here rather than a missing header.
  const providerOptions: Record<string, unknown> = {
    // One session id per call, so a provider's own logs can correlate a request
    // without this host inventing a session concept it does not have.
    [args.providerId === "codex-oauth" ? CODEX_SESSION_ID_OPTION : XAI_SESSION_ID_OPTION]:
      crypto.randomUUID(),
  };

  if (args.providerId === "codex-oauth") {
    // Codex requires the account id from the id token on every request;
    // without it the backend answers 401 even with a valid access token.
    const accountId = (tokens as { accountId?: string }).accountId;
    if (accountId !== undefined) providerOptions[CODEX_ACCOUNT_ID_OPTION] = accountId;
  } else {
    // The xAI proxy identifies the caller by `x-grok-user-id`, which the
    // adapter fills from this option. The package derives it from the access
    // token's subject; omitting it was leaving the header off entirely.
    const userId = xaiUserIdFromAccessToken(tokens.access);
    if (userId !== undefined) providerOptions[XAI_USER_ID_OPTION] = userId;
  }

  const source: InferenceSource = {
    id: args.providerId,
    provider: args.providerId,
    baseURL: definition.baseUrl,
    // Opaque here too — `readMaterial` below closes over the access token
    // this call already resolved rather than keying off a credential cell.
    credentialId: args.providerId,
    model: args.model,
  };

  let seq = 0;
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for await (const event of runInference({
    turns: [
      { role: "user", content: [{ type: "text", text: args.prompt }], timestamp: Date.now() },
    ],
    source,
    inferenceOptions: {
      systemPrompt: args.system,
      providerOptions,
      totalTimeoutMs: args.timeoutMs,
    },
    readMaterial: () => ({ secret: tokens.access }),
    deps: createDependencies(registryFor(args.providerId)),
    nextSeq: () => seq++,
  })) {
    if (event.type === "inference.error") {
      const failure = describeInferenceFailure({
        providerLabel: definition.label,
        providerId: args.providerId,
        error: event.data.error,
      });
      const error = new HostError(failure.code, failure.message, {}, failure.retryable);
      if (failure.remediation) error.remediation = failure.remediation;
      throw error;
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

  return { text, inputTokens, outputTokens };
}
