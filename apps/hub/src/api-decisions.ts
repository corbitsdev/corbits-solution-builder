import type { Hono } from "hono";
import { COMMANDS, type Command } from "@solutions-builder/app/ledger";
import { stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { HostError } from "./errors.js";
import { commandFrom } from "./api.js";

/**
 * The commands the host still applies itself, because each has an effect only
 * the host can produce: a project's tenant row, or (for the backtrack pair
 * below) creating a whole new run outside the lifecycle's per-stage chain.
 * Everything else a person decides is a named signal on the run, delivered by
 * the client over `/hub` — the host has no route for it, so there is nothing
 * here to bypass the grant with. `build.freeze` moved off this list: it is
 * now the freeze admission between stage 7's gate and stage 8's round
 * (`stage-loop.ts`'s `freezeSteps`), and its packet is written by
 * `command-ledger.ts` off that signal, not by this route.
 */
export const HOST_EFFECT_COMMANDS: readonly Command[] = [
  // stage.select_route and stage.retry stay host effects: backtrack routing
  // across stages and retrying a terminal stage run are not represented as
  // workflow transitions yet. The lifecycle's per-stage steps are a static,
  // linear chain the deployed workflow engine renders once at deploy time —
  // there is no primitive in `@intx/workflow` for a step to re-enter a
  // stage's loop after the workflow has already moved past it, or to select
  // a loop body dynamically by carried state. Building one is a workflow
  // engine feature, not a lane-sized cutover; tracked as CL-8461.
  "stage.select_route",
  "stage.retry",
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

    return context.json(await commandFrom(command, projectId, body));
  });
}
