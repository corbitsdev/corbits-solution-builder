/**
 * OAuth wiring smoke — BUILD_PLAN_V3 section 5.
 *
 * Proves the parts of the login lifecycle that can be checked without a human
 * at a browser: that the issuer configuration is real, that the authorize URL
 * is correctly formed with PKCE S256 and state, that the loopback callback
 * server binds the exact port each issuer registered, that cancelling tears it
 * down, and that a port conflict is reported rather than swallowed.
 *
 * It deliberately does not fake a completed login. Signing in needs a real
 * account; this checks everything up to that point.
 */
import { createServer } from "node:http";
import {
  DEFINITIONS,
  OAUTH_PROVIDERS,
  beginLogin,
  cancelLogin,
  hasSession,
  loginInFlight,
} from "../apps/hub/oauth.js";
import { HostError } from "../apps/hub/errors.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

for (const id of OAUTH_PROVIDERS) {
  const definition = DEFINITIONS[id];
  const redirect = new URL(definition.redirectUri);

  // A real signed-in session may already exist on this machine. The property
  // under test is that cancelling changes nothing — not that nobody has ever
  // signed in.
  const sessionBefore = await hasSession(id);

  const started = await beginLogin(id);
  const url = new URL(started.authorizeUrl);
  const params = url.searchParams;

  check(
    `${id}: authorize URL points at the issuer`,
    url.origin === new URL(definition.config.authorizeUrl).origin,
    url.origin,
  );
  check(
    `${id}: PKCE challenge is S256`,
    params.get("code_challenge_method") === "S256" &&
      (params.get("code_challenge")?.length ?? 0) >= 43,
  );
  check(
    `${id}: state is present and non-trivial`,
    (params.get("state")?.length ?? 0) >= 16,
  );
  check(
    `${id}: redirect_uri matches the issuer's registered value`,
    params.get("redirect_uri") === definition.redirectUri,
    params.get("redirect_uri") ?? "missing",
  );
  check(
    `${id}: client_id comes from the provider package`,
    params.get("client_id") === definition.config.clientId,
  );
  check(`${id}: a login is recorded as in flight`, loginInFlight() === id);

  // The callback server must actually be listening on the registered port.
  const bound = await fetch(`http://127.0.0.1:${redirect.port}${redirect.pathname}?error=probe`)
    .then((response) => response.status)
    .catch(() => 0);
  check(
    `${id}: the callback server is listening on port ${redirect.port}`,
    bound > 0,
    bound === 0 ? "nothing answered" : `HTTP ${bound}`,
  );

  cancelLogin();
  check(`${id}: cancelling clears the in-flight login`, loginInFlight() === null);

  // After cancellation the port must be free again — a stale callback has
  // nowhere to land.
  const afterCancel = await fetch(
    `http://127.0.0.1:${redirect.port}${redirect.pathname}?code=late`,
  )
    .then(() => true)
    .catch(() => false);
  check(`${id}: cancelling releases the callback port`, afterCancel === false);

  check(
    `${id}: a cancelled login stores no session`,
    (await hasSession(id)) === sessionBefore,
    sessionBefore ? "an existing signed-in session was left untouched" : "none stored",
  );
}

// A port conflict must be reported with the port named, not swallowed: these
// issuers accept exactly one redirect port each.
{
  const definition = DEFINITIONS["xai-oauth"];
  const port = Number(new URL(definition.redirectUri).port);
  const blocker = createServer((_, response) => response.end("busy"));
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));

  try {
    await beginLogin("xai-oauth");
    check("a busy callback port is reported", false, "the login started anyway");
  } catch (cause) {
    check(
      "a busy callback port is reported with the port named",
      cause instanceof HostError && cause.message.includes(String(port)),
      cause instanceof HostError ? cause.code : "unexpected error",
    );
  } finally {
    cancelLogin();
    blocker.close();
  }
}

// The Responses request is built by the providers' own `@intx/inference`
// adapters, not by this repository. These assert the shape they produce, which
// is checkable without spending a provider's quota.
{
  const { createCodexResponsesAdapter, parseCodexQuirks, CODEX_RESPONSES_PATH } = await import(
    "@corbits/codex-provider"
  );
  const { createXaiResponsesAdapter } = await import("@corbits/xai-provider");

  const codex = createCodexResponsesAdapter(
    { sourceId: "codex-oauth", provider: "codex-oauth", model: "gpt-5.5" },
    parseCodexQuirks({
      productName: "Solutions Builder",
      environmentTagName: "solutions_builder",
    }),
  );
  const request = codex.buildRequest(
    [{ role: "user", content: [{ type: "text", text: "Say ok." }], timestamp: Date.now() }],
    "gpt-5.5",
    { systemPrompt: "Reply with exactly: ok", providerOptions: { codexAccountId: "acct_123" } },
  );
  const body = JSON.parse(request.body) as Record<string, unknown>;

  check("codex adapter targets the Responses path", request.url.includes(CODEX_RESPONSES_PATH));
  check("codex adapter streams", body.stream === true);
  check(
    "codex adapter carries the account id the backend requires",
    request.headers["chatgpt-account-id"] === "acct_123",
  );
  check(
    "codex adapter opts out of the fields the backend rejects",
    body.store === false && body.parallel_tool_calls === false,
  );

  const { XAI_USER_ID_OPTION, xaiUserIdFromAccessToken } = await import("@corbits/xai-provider");
  const xai = createXaiResponsesAdapter({
    sourceId: "xai-oauth",
    provider: "xai-oauth",
    model: "grok-4.6",
  });
  const xaiRequest = xai.buildRequest(
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    "grok-4.6",
    { systemPrompt: "be brief", providerOptions: { [XAI_USER_ID_OPTION]: "user-abc" } },
  );
  check(
    "xai adapter carries its client headers",
    Object.keys(xaiRequest.headers).some((header) => header.startsWith("x-grok")),
  );
  // The proxy identifies the caller by this header; omitting the option left
  // it off entirely, which is why it is asserted rather than assumed.
  check(
    "xai adapter carries the caller's user id",
    xaiRequest.headers["x-grok-user-id"] === "user-abc",
  );
  check(
    "the user id is derived from the access token, not invented",
    xaiUserIdFromAccessToken("not.a.jwt") === undefined,
  );
}


// A secret store that cannot answer must not read as an empty one. This is the
// classification the key path depends on: mistaking "locked" or "denied" for
// "nothing stored" mints a replacement key over a good one, and everything
// sealed under it — every provider credential, every signed commit — is gone.
{
  const { classifySecurityExit } = await import(
    "../apps/hub/provider-credentials.js"
  );
  check(
    "a successful read is not a problem",
    classifySecurityExit(0, "") === null,
  );
  check(
    "exit 44 is an item that is not there",
    classifySecurityExit(44, "")?.status === "missing",
  );
  check(
    "a locked or denied keychain is unavailable, not missing",
    classifySecurityExit(51, "User interaction is not allowed.")?.status === "unavailable",
  );
  check(
    "and it says why",
    (classifySecurityExit(51, "User interaction is not allowed.") as { detail: string }).detail
      .includes("User interaction"),
  );
  check(
    "an exit with nothing on stderr still explains itself",
    (classifySecurityExit(1, "") as { detail: string }).detail.includes("exit code 1"),
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nOAuth smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
console.log(
  "Completing a sign-in needs a real account and a browser; this covers everything before that.",
);
process.exit(failed.length === 0 ? 0 : 1);
