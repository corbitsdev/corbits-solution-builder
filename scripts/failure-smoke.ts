/**
 * Provider failures: what a person is told, and how many were tried.
 *
 * Two defects reached the operator here:
 *
 *   1. a provider's raw JSON was rendered into the interface;
 *   2. after trying three providers in order and having all three refuse, only
 *      the last refusal was shown — which read as "it went straight to the
 *      third one" and made the ordering look broken when it was working.
 *
 * Both are about what the failure path *says*, so that is what this asserts.
 *
 * Usage: bun --conditions intx-src scripts/failure-smoke.ts
 */
import { describeProviderFailure, humanDuration } from "../apps/hub/src/failure.js";
import { aggregateRefusal } from "../apps/hub/src/inference.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

/** The exact bodies the operator's providers returned. */
const REAL = {
  rateLimited: `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"team","resets_at":1788898038,"eligible_promo":null,"resets_in_seconds":2794}}`,
  noBalance: `{"error":"Grok Build usage balance exhausted"}`,
  badParameter: `{"type":"error","error":{"type":"invalid_request_error","message":"\`temperature\` is deprecated for this model."},"request_id":"req_011CerWnpFb96UTCYzv3H6me"}`,
  html: `<html><head><title>502 Bad Gateway</title></head><body>…</body></html>`,
};

for (const [name, body] of Object.entries(REAL)) {
  const failure = describeProviderFailure({
    providerLabel: "Test provider",
    providerId: "test",
    status: name === "rateLimited" ? 429 : name === "noBalance" ? 402 : 400,
    body,
  });
  // The whole point: no JSON, no HTML, no request ids, no brace soup.
  const leaks = /[{}]|request_id|resets_in_seconds|<html|plan_type/.test(failure.message);
  check(`${name}: the message carries no raw payload`, !leaks, failure.message.slice(0, 80));
}

{
  const failure = describeProviderFailure({
    providerLabel: "ChatGPT (Codex)",
    providerId: "codex-oauth",
    status: 429,
    body: REAL.rateLimited,
  });
  check(
    "a rate limit says when it clears, in words",
    failure.message.includes("47 minutes"),
    failure.message,
  );
  check("a rate limit offers another provider", failure.remediation?.kind === "switch_provider");
}

{
  const failure = describeProviderFailure({
    providerLabel: "xAI (Grok)",
    providerId: "xai-oauth",
    status: 402,
    body: REAL.noBalance,
  });
  check(
    "an exhausted balance is named as one",
    failure.message.includes("balance") && failure.remediation?.kind === "switch_provider",
    failure.message,
  );
  check("an exhausted balance is not offered as retryable", failure.retryable === false);
}

{
  const failure = describeProviderFailure({
    providerLabel: "Anything",
    providerId: "x",
    status: 502,
    body: REAL.html,
  });
  check(
    "an HTML error page is not shown to a person",
    !failure.message.includes("<html"),
    failure.message.slice(0, 70),
  );
}

check("a reset time reads as words", humanDuration(2794) === "in about 47 minutes", humanDuration(2794));
check("a short reset reads as words", humanDuration(30) === "in under a minute");

// The aggregate message names every provider that was asked, in order, built
// by the product's own code so reverting that code fails this gate.
{
  const refusals = [
    { label: "Anthropic", reason: "Anthropic: `temperature` is deprecated for this model." },
    { label: "ChatGPT (Codex)", reason: "ChatGPT (Codex) has no capacity left right now." },
    { label: "xAI (Grok)", reason: "xAI (Grok) has no balance left." },
  ];
  const summary = aggregateRefusal(refusals);

  check("the summary says how many were tried", summary.includes("3 providers"));
  for (const refusal of refusals) {
    check(`the summary names ${refusal.label}`, summary.includes(refusal.label));
  }
  check(
    "the summary preserves the order they were tried in",
    summary.indexOf("Anthropic") < summary.indexOf("ChatGPT") &&
      summary.indexOf("ChatGPT") < summary.indexOf("xAI"),
  );
}


// A model that rejects `temperature` must not fail forever. The retry is
// per-process and per-model, so the second call to the same model omits the
// parameter without another wasted round trip.
{
  const { retriesWithoutTemperature } = await import(
    "../apps/hub/src/inference.js"
  );
  check(
    "a refusal naming temperature is recognised as one",
    retriesWithoutTemperature(new Error("400: `temperature` is not supported for this model")),
  );
  check(
    "and an unrelated refusal is not",
    !retriesWithoutTemperature(new Error("401: invalid api key")),
  );
  check(
    "a refusal that only mentions the word in passing still retries rather than failing shut",
    retriesWithoutTemperature(new Error("Unsupported parameter: temperature")),
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nFailure smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
