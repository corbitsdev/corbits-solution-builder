import { CODEX_RESPONSES_PATH } from "@corbits/codex-provider";
import { createOpenAIResponsesAdapter } from "@corbits/openai-responses";
import type { AdapterFactory } from "@intx/inference";

// ChatGPT's Codex backend drops the Content-Type on its SSE stream. Classifying
// it here needs the patched harness hook (faremeter/interchange#198).
export const createResponsesAdapter: AdapterFactory = (source, quirks) => {
  const adapter = createOpenAIResponsesAdapter(source, quirks);
  const codex = (quirks as { path?: unknown } | undefined)?.path === CODEX_RESPONSES_PATH;
  return codex ? { ...adapter, classifyResponse: () => "sse" } : adapter;
};
