/**
 * Names a new project from its opening problem statement:
 *
 *   POST /projects/:id/title    { problemStatement } -> { reply, model }
 *
 * One inference call on the default offering the project's tenant sees (its
 * own catalog and the workspace's it inherits), the namer's prompt as its
 * system prompt. The reply is returned as the model wrote it; the client
 * decides whether it is a usable title and writes it through the installer.
 * Unavailable (no embedded hub, nothing connected) is a 503, and the project
 * keeps the title it was created with.
 */
import type { Hono } from "hono";
import { type } from "arktype";
import { HostError, hub, hubIsMounted, NoInferenceSourceError } from "@corbits/embedded-host";
import { namer } from "@solutions-builder/specialist-companions";
import { projectParam } from "./api-build.js";
import { parsed } from "./validation.js";

const TitleBody = type({ problemStatement: "string > 0" });

/** A title is one short line; this bounds a model that ignores that. */
const TITLE_MAX_TOKENS = 64;

export function registerProjectTitleRoutes(api: Hono) {
  api.post("/projects/:id/title", async (context) => {
    const projectId = await projectParam(context);
    const { problemStatement } = parsed(TitleBody(await context.req.json().catch(() => ({}))));
    if (!hubIsMounted()) throw new HostError("provider_unavailable", "Naming runs only against the embedded hub.");
    try {
      const completion = await hub().complete({
        tenantId: projectId,
        systemPrompt: namer.system,
        input: JSON.stringify({ problemStatement }),
        temperature: namer.temperature,
        maxTokens: TITLE_MAX_TOKENS,
      });
      return context.json({ reply: completion.text, model: `${completion.provider}/${completion.model}` });
    } catch (cause) {
      if (cause instanceof NoInferenceSourceError) throw new HostError("provider_unavailable", "Connect a model provider to name projects.");
      console.error("[project-title]", cause);
      throw new HostError("provider_unavailable", "The model could not name this project.", {}, true);
    }
  });
}
