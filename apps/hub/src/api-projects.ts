import type { Hono } from "hono";
import { listProjects } from "./projects.js";

/**
 * What's left of the project HTTP surface once the client reads its own
 * detail (CL-8510, step C of CL-8072): the list stays, since
 * `apps/web/src/project-list.ts`'s own client fold is a coarser read (no
 * ledger-titled wait) that still leans on this for the decision queue's
 * `needsDecision` gloss — everything else (`GET /projects/:id`, `/info`,
 * `/graph`, `POST /material`, `POST /artifacts/:id/save`, `GET /decisions`,
 * `POST /projects/:id/open`) is gone. `apps/web/src/client.ts`'s
 * `projectView`/`projectInfo`/`artifactGraph`/`attachMaterial`/`decisions`
 * fold the same reads over `/hub` instead; artifact downloads are a browser
 * save of `artifactContent`, not a host-written file.
 */
export function registerProjectRoutes(api: Hono) {
  api.get("/projects", async (context) => context.json({ projects: await listProjects() }));
}
