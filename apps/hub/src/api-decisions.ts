import type { Hono } from "hono";
import { BuildAnswerPayload, BuildFreezePayload } from "./domain.js";
import { COMMANDS, type Command } from "@solutions-builder/app/ledger";
import { stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { HostError } from "./errors.js";
import { commandFrom, parsed } from "./api.js";

/**
 * The commands the host still applies itself, because each has an effect only
 * the host can produce: an artifact version, a worker's answer, a project's
 * tenant row. Everything else a person decides is a named signal on the run,
 * delivered by the client over `/hub` — the host has no route for it, so there
 * is nothing here to bypass the grant with.
 */
export const HOST_EFFECT_COMMANDS: readonly Command[] = [
  "build.freeze",
  "build.start_attempt",
  "build.answer",
  "stage.select_route",
  "stage.retry",
  "build.resume",
  "project.archive",
  "project.delete",
];

export function registerDecisionRoutes(api: Hono) {
  /** One route for the host's own effects; a gate command is decided on the run and 404s here. */
  api.post("/projects/:projectId/commands/:command", async (context) => {
    const projectId = context.req.param("projectId");
    const command = context.req.param("command") as Command;
    if (!(COMMANDS as readonly string[]).includes(command)) {
      throw new HostError("validation_failed", `Unknown command: ${command}.`);
    }
    if (!HOST_EFFECT_COMMANDS.includes(command)) {
      throw new HostError(
        "not_found",
        `${command} is decided on the run: deliver the ${stageSignal(1, command).name.replace(".1.", ".<stage>.")} signal over /hub.`,
      );
    }
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>;

    // Validation is per command, at this boundary, once.
    switch (command) {
      case "build.freeze":
        parsed(BuildFreezePayload(body));
        break;
      case "build.answer":
        parsed(BuildAnswerPayload(body));
        break;
      default:
        break;
    }

    return context.json(await commandFrom(command, projectId, body));
  });
}
