/**
 * Recovers a stage conversation from a project this workspace still holds
 * the runs for — a deleted one, most often — onto another project here,
 * as carried turns.
 *
 * Why this exists: a project export written before conversations travelled
 * (#188) carried no thread. Someone who exported such a bundle, deleted the
 * original and imported the bundle again has a project with its documents
 * and none of the specialist's questions. Deleting a project is a soft
 * delete, and the platform keeps the lifecycle runs the conversation is
 * projected from, so it is all still here. This reads it from the original
 * and records it on the copy, the way import now does for a new bundle.
 *
 * Run with the host stopped, since the database is one process's at a time:
 *
 *   bun --conditions intx-src scripts/recover-conversation.ts            # what is here
 *   bun --conditions intx-src scripts/recover-conversation.ts <from> <to> # copy from → to
 *
 * `from` and `to` are project ids from the listing. Nothing on `from` is
 * changed; turns already on `to` by id are left as they are.
 */
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { assets, ensureHub, localActor } from "../apps/hub/src/hub-client.js";
import { install } from "../apps/hub/src/installer-bridge.js";
import { listProjectRecords, readProject } from "../apps/hub/src/installer-bridge.js";
import { recordCarriedTurns, allCarriedTurns } from "../apps/hub/src/engine-ledger.js";
import { portableThread } from "../apps/hub/src/stage-thread.js";
import { databaseDirectory } from "../apps/hub/src/paths.js";
import { STAGES } from "@solutions-builder/app/ledger";

const [from, to] = process.argv.slice(2);

const host = await openDatabase(databaseDirectory());
await prepareDatabase(host);
await ensureHub();
await install();
void localActor();

/** Every project id a lifecycle asset was ever deployed for here, deleted ones included. */
async function projectIdsWithRuns(): Promise<string[]> {
  const names = (await assets.list("workflow")).map((asset) => asset.name);
  const ids: string[] = [];
  for (const name of names) {
    const match = /^solutions-builder-project-lifecycle-tnt-([a-z0-9]+)$/.exec(name);
    if (match) ids.push(`tnt_${match[1]}`);
  }
  return ids;
}

async function turnsByStage(projectId: string): Promise<Map<number, Awaited<ReturnType<typeof portableThread>>>> {
  const result = new Map<number, Awaited<ReturnType<typeof portableThread>>>();
  for (const stage of STAGES) {
    const turns = await portableThread(projectId, stage).catch(() => []);
    if (turns.length > 0) result.set(stage, turns);
  }
  return result;
}

if (!from || !to) {
  const live = new Map((await listProjectRecords()).map((record) => [record.id, record.title]));
  const ids = new Set([...(await projectIdsWithRuns()), ...live.keys()]);
  for (const id of ids) {
    const turns = await turnsByStage(id);
    const stages = [...turns.entries()].map(([stage, list]) => `stage ${stage}: ${list.length} turns`).join(", ");
    const carried = (await allCarriedTurns(id).catch(() => [])).length;
    console.log(`${id}  ${live.has(id) ? `"${live.get(id)}"` : "(deleted)"}  ${stages || "no conversation"}${carried ? `  (${carried} carried in)` : ""}`);
  }
  process.exit(0);
}

const target = await readProject(to);
if (!target) {
  console.error(`No live project ${to} here.`);
  process.exit(1);
}
const turns = await turnsByStage(from);
if (turns.size === 0) {
  console.error(`No conversation is held here for ${from}.`);
  process.exit(1);
}
for (const [stage, list] of turns) {
  await recordCarriedTurns(to, stage, list.map((turn) => ({ ...turn, quotes: [...turn.quotes] })));
  console.log(`stage ${stage}: ${list.length} turns recorded on "${target.title}"`);
}
process.exit(0);
