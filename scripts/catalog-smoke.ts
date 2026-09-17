/**
 * The native model catalog — BUILD_PLAN_V3 sections 5 and 8.
 *
 * The claim under test is the one the onboarding design is built around: a
 * credential seeded when someone connects a provider is linked to the
 * capabilities being deployed, in Interchange's own tables rather than in a
 * private copy of them. Connecting a provider must produce a `model_provider`
 * row pointing at the `credential` row, a `model` row per model it serves, and
 * a `model_offering` joining them — and the plaintext secret must appear in none of it.
 *
 * A stub provider stands in for a vendor: this proves the wiring, not that
 * anyone's API key is valid.
 */
import "./smoke-env.js";
import { createServer } from "node:http";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { mountHub, hub } from "../apps/hub/src/hub-mount.js";
import { install } from "../apps/hub/src/installer-bridge.js";
import { connectProvider } from "../apps/hub/src/providers.js";

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
await install();

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
  "the credential row holds the sealed secret, never the plaintext",
  typeof credential?.secret === "string" && credential.secret.startsWith("enc:") && !credential.secret.includes(SECRET),
  String(credential?.secret).slice(0, 24),
);

// The plaintext key must not be recoverable from any row the hub keeps.
// The sealed column is Interchange ciphertext; metadata.ref is the keychain
// copy the host uses for its own reads.
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
// The stub server's models are not in the real inference catalog, and the
// stub's `/models` listing carries nothing beyond an id, so the honest
// fallback applies: no capability is claimed, rather than a guess.
check(
  "and advertise the honest fallback for a model the catalog does not know",
  offerings.length > 0 &&
    offerings.every((row) => (row.capabilities as string[]).length === 0),
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
  "../apps/hub/src/providers.js"
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
  const { disconnectCatalogProvider } = await import("../apps/hub/src/catalog.js");
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

// CL-7573: a local endpoint (Ollama-style, keyless) must land in exactly the
// same catalog rows as every other provider — no `builder.local_provider`
// row survives it.
{
  const LOCAL_MODELS = ["llama3.2", "qwen2.5"];
  const local = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: LOCAL_MODELS.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const localPort = (local.address() as { port: number }).port;

  const { connectProvider, listProviders, setProviderOrder, selectModel, disconnectProvider } =
    await import("../apps/hub/src/providers.js");

  const connected = await connectProvider({
    providerId: "local",
    label: "Local endpoint",
    kind: "local_endpoint",
    baseUrl: `http://127.0.0.1:${localPort}`,
  });
  check(
    "connecting a local endpoint reports it ready with no credential",
    connected.status === "ready" && connected.hasCredential === false,
    `${connected.status}, hasCredential=${connected.hasCredential}`,
  );

  const providerRowsAfterLocal = await rows("select * from public.model_provider");
  check(
    "the local endpoint writes a model_provider row like any other provider",
    providerRowsAfterLocal.some((row) => row.name === "local"),
  );
  const localModelRows = await rows(
    "select m.canonical_name from public.model m join public.model_offering mo on mo.model_id = m.id " +
      "join public.model_provider mp on mp.id = mo.provider_id where mp.name = 'local'",
  );
  check(
    "every model the local endpoint probed is in the catalog",
    localModelRows.length === LOCAL_MODELS.length,
    localModelRows.map((row) => row.canonical_name).join(", "),
  );
  const tableCheck = await rows(
    "select table_name from information_schema.tables where table_schema = 'builder' and table_name = 'local_provider'",
  );
  check("`builder.local_provider` does not exist", tableCheck.length === 0);

  const reorderedWithLocal = await setProviderOrder(["local", "openrouter"]);
  check(
    "reordering with the local endpoint round-trips through the catalog",
    reorderedWithLocal[0]?.providerId === "local" && reorderedWithLocal[1]?.providerId === "openrouter",
    reorderedWithLocal.map((entry) => entry.providerId).join(", "),
  );

  const selectedLocal = await selectModel("local", "qwen2.5");
  check(
    "selecting a model on the local endpoint round-trips through the catalog",
    selectedLocal.selectedModel === "qwen2.5",
    String(selectedLocal.selectedModel),
  );
  const cleared = await selectModel("local", null);
  check("clearing the choice leaves the host to pick again", cleared.selectedModel === null, String(cleared.selectedModel));

  await disconnectProvider("local");
  const afterLocalDisconnect = await listProviders();
  check(
    "disconnecting the local endpoint removes its catalog rows",
    !afterLocalDisconnect.some((entry) => entry.providerId === "local") &&
      !(await rows("select * from public.model_provider")).some((row) => row.name === "local"),
  );

  local.close();
}

// A first-party OpenAI listing mixes every kind of model into one reply,
// and the lifecycle pins whichever offering comes first. Recorded, the
// listing leads with a model that can answer, in the catalog's order; the
// ones that cannot are disabled behind it and kept out of the operator's
// rows, so none is offered as a choice or read as one.
{
  const { registerProviderCatalog, getCatalogProvider, rerankCatalogProviders } = await import("../apps/hub/src/catalog.js");
  // The listing is recorded directly, as a connect would record it once the
  // key had been validated; the stub's credential (connected again, since
  // the earlier connection was taken down above) stands in for OpenAI's.
  const relisted = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "stub-again" }] }));
  });
  await new Promise<void>((resolve) => relisted.listen(0, "127.0.0.1", resolve));
  await connectProvider({
    providerId: "compatible",
    label: "Stub provider",
    kind: "api_key",
    secret: SECRET,
    baseUrl: `http://127.0.0.1:${(relisted.address() as { port: number }).port}`,
  });
  const stubRow = (await rows("select credential_id from public.model_provider where name = 'compatible'"))[0] as { credential_id: string };
  const listing = ["text-embedding-ada-002", "whisper-1", "gpt-3.5-turbo-16k", "gpt-4o-mini", "tts-1", "gpt-4-0613", "gpt-4.1", "o1-pro", "gpt-5.5", "gpt-4o-2024-08-06"];
  await registerProviderCatalog({
    providerId: "openai",
    label: "OpenAI",
    plugin: "openai",
    baseUrl: "https://api.openai.com/v1",
    credentialId: stubRow.credential_id,
    models: listing,
    priority: 3,
  });
  relisted.close();
  const openai = await getCatalogProvider("openai");
  const served = openai?.models.map((entry) => entry.canonicalName) ?? [];
  check(
    "a first-party OpenAI listing leads with a chat model the catalog knows, in the catalog's order",
    served.slice(0, 3).join(",") === "gpt-5.5,gpt-4.1,gpt-4o-mini",
    served.join(","),
  );
  check(
    "models that cannot answer a chat completion, or hold the documents, are kept out of the provider's rows",
    !served.some((name) => /embedding|whisper|tts|o1-pro|gpt-3\.5|gpt-4-0613/.test(name)) && served.includes("gpt-4o-2024-08-06"),
    served.join(","),
  );
  const unservable = "select o.priority, o.disabled, m.canonical_name from public.model_offering o join public.model m on m.id = o.model_id where m.canonical_name in ('text-embedding-ada-002','whisper-1','tts-1','o1-pro','text-embedding-3-small')";
  check("and they are recorded as no offering at all", (await rows(unservable)).length === 0);
  check("and no model reads as the operator's chosen one", openai?.models.every((entry) => !entry.disabled) === true);

  // A workspace connected before the listing was read this way holds such
  // an offering already, and at the front: the very shape that pinned the
  // lifecycle to an embeddings model. Install reranks it behind and off.
  const { catalog } = await import("../apps/hub/src/hub-client.js");
  const planted = await catalog.createModel({ canonicalName: "text-embedding-3-small", displayName: "text-embedding-3-small" });
  await catalog.createOffering({ modelId: planted.id, providerId: openai!.providerRowId, priority: 3000, capabilities: [] });
  // And the operator had chosen it: every other offering is disabled. The
  // rerank must not leave the provider serving nothing.
  for (const entry of openai!.models) await catalog.patchOffering(entry.offeringId, { disabled: true });
  await rerankCatalogProviders();
  const retired = (await rows(unservable)) as { priority: number; disabled: boolean }[];
  const reranked = (await getCatalogProvider("openai"))?.models ?? [];
  check(
    "reranking on install disables an offering that cannot answer and moves it behind every served one",
    retired.length === 1 && retired[0]!.disabled && retired[0]!.priority >= 3900,
    JSON.stringify(retired),
  );
  check(
    "and the served ones lead again, in the catalog's order",
    reranked[0]?.canonicalName === "gpt-5.5" && reranked[0].priority === 3000 && !reranked.some((entry) => entry.canonicalName === "text-embedding-3-small"),
    reranked.map((entry) => `${entry.canonicalName}:${entry.priority}`).join(","),
  );
  check(
    "a choice of a model that cannot serve is cleared rather than leaving the provider serving nothing",
    reranked.length > 0 && reranked.every((entry) => !entry.disabled),
    reranked.map((entry) => `${entry.canonicalName}:${entry.disabled ? "off" : "on"}`).join(","),
  );
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nCatalog smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
