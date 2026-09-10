/**
 * The native model catalog — BUILD_PLAN_V3 sections 5 and 8.
 *
 * The claim under test is the one the onboarding design is built around: a
 * credential seeded when someone connects a provider is linked to the
 * capabilities being deployed, in Interchange's own tables rather than in a
 * private copy of them. Connecting a provider must produce a `model_provider`
 * row pointing at the `credential` row, a `model` row per model it serves, and
 * a `model_offering` joining them — and the secret must appear in none of it.
 *
 * A stub provider stands in for a vendor: this proves the wiring, not that
 * anyone's API key is valid.
 */
import { createServer } from "node:http";
import { openDatabase } from "../apps/hub/db.js";
import { prepareDatabase } from "../apps/hub/migrate.js";
import { mountHub, hub } from "../apps/hub/hub-mount.js";
import { ensureWorkspace } from "../apps/hub/projects.js";
import { connectProvider } from "../apps/hub/providers.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const SECRET = "sk-stub-do-not-store-me-anywhere";
const MODELS = ["stub-large", "stub-small"];

const stub = createServer((request, response) => {
  if ((request.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
    response.writeHead(401).end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const port = (stub.address() as { port: number }).port;

const host = await openDatabase();
await prepareDatabase(host);
await mountHub();
await ensureWorkspace({ principalId: "p_owner", displayName: "You" });

await connectProvider({
  providerId: "compatible",
  label: "Stub provider",
  kind: "api_key",
  secret: SECRET,
  baseUrl: `http://127.0.0.1:${port}`,
});

const db = hub().db.db as unknown as { execute: (q: string) => Promise<{ rows?: unknown[] }> };
const rows = async (sql: string) => {
  const out = await db.execute(sql);
  return (out.rows ?? (out as unknown as unknown[])) as Record<string, unknown>[];
};

const providers = await rows("select * from public.model_provider");
check("connecting a provider writes a native model_provider row", providers.length === 1);

const provider = providers[0] ?? {};
check(
  "the provider names the adapter that serves it",
  provider.plugin === "openai-compatible",
  String(provider.plugin),
);
check(
  "and points at a credential rather than carrying a secret",
  typeof provider.credential_id === "string" && provider.credential_id.length > 0,
  String(provider.credential_id),
);

const credentials = await rows("select * from public.credential");
const credential = credentials.find((row) => row.id === provider.credential_id);
check("the credential it points at exists", credential !== undefined);
check(
  "the credential holds a keychain reference, not the secret",
  typeof credential?.secret === "string" && credential.secret.startsWith("keychain:"),
  String(credential?.secret).slice(0, 24),
);

// The whole point of the reference: the secret must not be recoverable from
// any row the hub keeps.
const everything = JSON.stringify([...providers, ...credentials, ...(await rows("select * from public.model_offering")), ...(await rows("select * from public.model"))]);
check("the secret appears in none of the catalog rows", !everything.includes(SECRET));

const models = await rows("select * from public.model order by canonical_name");
check(
  "every model the provider serves is in the catalog",
  models.length === MODELS.length &&
    MODELS.every((name) => models.some((row) => row.canonical_name === name)),
  models.map((row) => row.canonical_name).join(", "),
);

const offerings = await rows("select * from public.model_offering");
check(
  "each model is joined to the provider by an offering",
  offerings.length === MODELS.length,
  `${offerings.length} offerings`,
);
// `every` on an empty array is true, so these would pass on no offerings at
// all — the failure this file exists to catch.
check(
  "offerings carry a resolution order",
  offerings.length > 0 && offerings.every((row) => typeof row.priority === "number"),
);
// The stub server's models are not in the real inference catalog, so the
// honest fallback applies: plain text only, nothing this build has not
// verified for them.
check(
  "and advertise the honest fallback for a model the catalog does not know",
  offerings.length > 0 &&
    offerings.every(
      (row) =>
        (row.capabilities as string[]).includes("plain-text") &&
        !(row.capabilities as string[]).includes("function-calling"),
    ),
);

// Reconnecting is what an expired key looks like. It must update the catalog,
// not grow a second copy of it.
await connectProvider({
  providerId: "compatible",
  label: "Stub provider",
  kind: "api_key",
  secret: SECRET,
  baseUrl: `http://127.0.0.1:${port}`,
});
check(
  "reconnecting updates the catalog rather than duplicating it",
  (await rows("select * from public.model_provider")).length === 1 &&
    (await rows("select * from public.model_offering")).length === MODELS.length,
);

// The failure this file was written to catch was invisible because it was
// logged. The binding must say so instead.
const { listProviders, setProviderOrder, disconnectProvider, selectModel } = await import(
  "../apps/hub/providers.js"
);
const bindings = await listProviders();
check(
  "a connection the hub accepted reports no hub failure",
  bindings.every((entry) => entry.statusDetail === null),
  bindings.map((entry) => entry.statusDetail ?? "ok").join(", "),
);

// `provider_binding` is gone: everything the registry reports about a
// connected provider — label, models, status — must come back from the
// platform's own tables through `listProviders`, not a private copy of it.
check(
  "listing reads the connection back from the platform's tables",
  bindings.length === 1 && bindings[0]!.providerId === "compatible" && bindings[0]!.status === "ready",
  JSON.stringify(bindings.map((entry) => ({ id: entry.providerId, status: entry.status }))),
);

const selected = await selectModel("compatible", "stub-small");
check(
  "selecting a model narrows the provider to that one offering",
  selected.selectedModel === "stub-small",
  String(selected.selectedModel),
);
const narrowedOfferings = await rows(
  "select * from public.model_offering where provider_id = (select id from public.model_provider limit 1)",
);
check(
  "narrowing disables the offerings for every other model, not just the row",
  narrowedOfferings.filter((row) => !row.disabled).length === 1,
  `${narrowedOfferings.filter((row) => !row.disabled).length} enabled of ${narrowedOfferings.length}`,
);

// A second stub provider, so ordering has something to reorder.
const stub2 = createServer((request, response) => {
  if ((request.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
    response.writeHead(401).end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
});
await new Promise<void>((resolve) => stub2.listen(0, "127.0.0.1", resolve));
const port2 = (stub2.address() as { port: number }).port;
await connectProvider({
  providerId: "openrouter",
  label: "Second stub provider",
  kind: "api_key",
  secret: SECRET,
  baseUrl: `http://127.0.0.1:${port2}`,
});

const reordered = await setProviderOrder(["openrouter", "compatible"]);
check(
  "reordering moves the operator's chosen provider first",
  reordered[0]?.providerId === "openrouter" && reordered[1]?.providerId === "compatible",
  reordered.map((entry) => entry.providerId).join(", "),
);

await disconnectProvider("openrouter");
const afterDisconnect = await listProviders();
check(
  "disconnecting removes the provider from the platform's tables, not just the list",
  afterDisconnect.length === 1 &&
    (await rows("select * from public.model_provider")).length === 1,
  `${afterDisconnect.length} providers, ${(await rows("select * from public.model_provider")).length} model_provider rows`,
);

stub2.close();

// A connect that fails must leave nothing behind. Two halves, because they
// fail in different places: a provider that never validates must not reach the
// platform at all, and a connection that IS recorded and then rolled back must
// take its credential row with it — the window that used to leave a row
// pointing at a keychain entry already deleted.
{
  const before = await rows("select * from public.credential");
  let refused = "";
  await connectProvider({
    providerId: "ghost",
    label: "Ghost provider",
    kind: "api_key",
    secret: "sk-ghost",
    baseUrl: "http://127.0.0.1:1",
  }).catch((cause: unknown) => {
    refused = cause instanceof Error ? cause.message : String(cause);
  });
  check(
    "a provider that never validates writes nothing to the platform",
    (await rows("select * from public.credential")).length === before.length,
    refused.slice(0, 48),
  );

  // The rollback itself, on a connection that really was written. This is the
  // path `connectProvider`'s catch takes.
  const { disconnectCatalogProvider } = await import("../apps/hub/hub-catalog.js");
  const recorded = await rows("select * from public.credential");
  check(
    "the stub provider's credential is on record before the rollback",
    recorded.some((row) => String(row.name).includes("compatible")),
  );
  await disconnectCatalogProvider("compatible");
  const rolledBack = await rows("select * from public.credential");
  check(
    "rolling a provider back removes its credential row, not just its offerings",
    !rolledBack.some((row) => String(row.name).includes("compatible")),
    `${recorded.length} then ${rolledBack.length}`,
  );
  check(
    "and leaves no model_provider row behind",
    (await rows("select * from public.model_provider")).every((row) => row.name !== "compatible"),
  );
}


// A pasted key routinely carries a trailing newline. Sending it unchanged
// gets the same 401 an invalid key gets, and the person is told their key is
// wrong when it is fine.
{
  const before = (await rows("select * from public.model_provider")).length;
  const padded = createServer((request, response) => {
    if ((request.headers.authorization ?? "") !== `Bearer ${SECRET}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "trimmed-model" }] }));
  });
  await new Promise<void>((resolve) => padded.listen(0, "127.0.0.1", resolve));
  const paddedPort = (padded.address() as { port: number }).port;

  let refused = "";
  await connectProvider({
    providerId: "openrouter",
    label: "Whitespace test",
    kind: "api_key",
    secret: `  ${SECRET}\n`,
    baseUrl: `http://127.0.0.1:${paddedPort}`,
  }).catch((cause: unknown) => {
    refused = cause instanceof Error ? cause.message : String(cause);
  });
  padded.close();

  check(
    "a key pasted with surrounding whitespace still connects",
    refused === "",
    refused.slice(0, 60) || "connected",
  );
  check(
    "and it landed as a real provider",
    (await rows("select * from public.model_provider")).length === before + 1,
  );
}

stub.close();
const failed = checks.filter((entry) => !entry.ok);
console.log(`\nCatalog smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
