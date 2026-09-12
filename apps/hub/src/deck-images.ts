/**
 * Illustrations for a stakeholder's slides, drawn by the inference
 * provider's image model. The provider is one the person has connected
 * whose listing carries an image model; the call goes to its images
 * endpoint with the provider's own key, the way the host validates a key.
 * Every image is kept on disk under the hash of what it was asked for, so a
 * deck built again with the same slides asks for nothing twice.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { catalog } from "./hub-client.js";
import { HostError } from "./errors.js";
import { dataDirectory } from "./paths.js";
import { credentialFor, listProviders } from "./providers.js";

export type ImageSource = { providerId: string; label: string; baseUrl: string; model: string; key: string };

/**
 * An image model, by name: OpenAI's gpt-image family and DALL·E, xAI's Grok
 * image models, and on any compatible endpoint whatever calls itself an
 * image model. A chat model that merely takes images as input does not
 * carry the word.
 */
const IMAGE_MODELS = /^(gpt-image-[\w.-]+|dall-e-\d|[\w.-]*image[\w.-]*)$/i;
const IMAGE_RANK = ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"];

/**
 * The first connected provider, in the person's order, that lists an image
 * model. The listing is read raw: an image model is set aside from what a
 * provider serves the lifecycle with, and it is looked for here by name.
 */
export async function imageSource(): Promise<ImageSource | null> {
  const providers = (await listProviders()).filter((provider) => provider.status === "ready" && provider.hasCredential);
  if (providers.length === 0) return null;
  const [rows, models, offerings] = await Promise.all([catalog.modelProviders(), catalog.models(), catalog.offerings()]);
  for (const provider of providers) {
    if (provider.providerId === "anthropic") continue;
    const row = rows.find((entry) => entry.name === provider.providerId);
    if (!row) continue;
    const listed = offerings
      .filter((offering) => offering.providerId === row.id)
      .map((offering) => models.find((model) => model.id === offering.modelId)?.canonicalName ?? "")
      .filter((name) => IMAGE_MODELS.test(name))
      .sort((a, b) => rank(a) - rank(b));
    const model = listed[0];
    if (!model) continue;
    const key = await credentialFor(provider);
    if (!key) continue;
    return { providerId: provider.providerId, label: provider.label, baseUrl: (row.baseURL ?? provider.baseUrl ?? "").replace(/\/+$/, ""), model, key };
  }
  return null;
}

function rank(model: string): number {
  const index = IMAGE_RANK.indexOf(model);
  return index === -1 ? IMAGE_RANK.length : index;
}

function cacheDirectory(): string {
  return join(dataDirectory(), "deck-images");
}

/** One illustration, PNG bytes: from the cache when the same thing was asked of the same model before. */
export async function illustration(source: ImageSource, prompt: string): Promise<Uint8Array> {
  const key = createHash("sha256").update(`${source.model}\n${prompt}`).digest("hex");
  const path = join(cacheDirectory(), `${key}.png`);
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    // Not drawn yet.
  }
  const bytes = await generate(source, prompt);
  await mkdir(cacheDirectory(), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

async function generate(source: ImageSource, prompt: string): Promise<Uint8Array> {
  const body: Record<string, unknown> = { model: source.model, prompt, n: 1 };
  if (source.model.startsWith("gpt-image")) {
    body.size = "1536x1024";
    body.quality = "medium";
  } else if (source.model === "dall-e-3") {
    body.size = "1792x1024";
    body.response_format = "b64_json";
  } else {
    body.response_format = "b64_json";
  }
  const response = await fetch(`${source.baseUrl}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${source.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let said = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      said = parsed.error?.message ?? said;
    } catch {
      // Left as text.
    }
    throw new HostError("provider_unavailable", `${source.label} could not draw the image with ${source.model} [HTTP ${response.status}]: ${said}`, {}, true);
  }
  const parsed = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
  const first = parsed.data?.[0];
  if (first?.b64_json) return new Uint8Array(Buffer.from(first.b64_json, "base64"));
  if (first?.url) {
    const fetched = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!fetched.ok) throw new HostError("provider_unavailable", `${source.label} drew the image but it could not be fetched [HTTP ${fetched.status}].`, {}, true);
    return new Uint8Array(await fetched.arrayBuffer());
  }
  throw new HostError("provider_unavailable", `${source.label} answered without an image.`, {}, true);
}

/** What a slide's illustration is asked to be: its subject from the slide, its manner fixed, never any lettering. */
export function illustrationPrompt(args: { projectTitle: string; audience: string; role: string; title: string; gist: string; colour: string }): string {
  return [
    `An editorial illustration for one slide of a short business presentation titled "${args.projectTitle}", prepared for a ${args.role}.`,
    `The slide is "${args.title}". Its point: ${args.gist}`,
    `Flat vector style, clean shapes, generous negative space, a restrained palette built around ${args.colour}, on a plain white background.`,
    "No text, no words, no letters, no numbers, no logos, no charts with labels. No people's faces.",
  ].join(" ");
}
