/**
 * The workflows BUILD_PLAN_V3 §9 names, seeded and idempotent.
 *
 * §9 asks for project-lifecycle, stage, approval, design-feedback,
 * provider-switch, build-supervision and delivery, seeded through native
 * Interchange facilities, with reconciliation creating what is missing. For a
 * long time only the first existed, and nothing said so — the host printed
 * "Workflow definitions up to date (1)" and that read like success.
 *
 * So this asserts the set, that seeding twice creates nothing the second time,
 * and the two properties §7 will not survive losing: every stage still ends at
 * a human gate, and the loop inside a stage is bounded.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub } from "../apps/hub/src/hub-endpoint.js";
import { ensureWorkspace } from "../apps/hub/src/projects.js";
import { seedWorkflows } from "../apps/hub/src/workflow-seed.js";
import { projectLifecycleDefinition } from "@solutions-builder/app/workflows/project-lifecycle";
import { stageDefinition, MAX_REVISIONS } from "@solutions-builder/app/workflows/stage-loop";
import { STAGES } from "@solutions-builder/app/ledger";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}


const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-workflows-"));
await prepareDatabase(await openDatabase(`${dataDir}/pglite`));
// Seeding writes into the hub's own tables, so the hub has to be mounted the
// way the host mounts it.
const endpoint = await ensureHub();
// Definitions are tenant-scoped, and the workspace is what creates the tenant.
await ensureWorkspace({ principalId: "p_owner", displayName: "You" });
check("the hub is mounted embedded", endpoint.mode === "embedded" && endpoint.ready);

const first = await seedWorkflows();
const names = new Set(first.map((entry) => entry.name));

for (const required of [
  "solutions-builder.project-lifecycle",
  "solutions-builder.approval",
  "solutions-builder.design-feedback",
  "solutions-builder.provider-switch",
  "solutions-builder.build-supervision",
  "solutions-builder.delivery",
]) {
  check(`${required} is seeded`, names.has(required));
}
check(
  "one stage workflow per stage",
  STAGES.every((stage) => names.has(`solutions-builder.stage.${stage}`)),
  `${STAGES.length} expected`,
);
check("everything was created on a fresh workspace", first.every((entry) => entry.created));

// §9: reconciliation creates what is missing and nothing else.
const second = await seedWorkflows();
check(
  "seeding again creates nothing",
  second.every((entry) => !entry.created),
  `${second.filter((entry) => entry.created).length} recreated`,
);
check(
  "and returns the same definitions",
  second.length === first.length &&
    second.every((entry, index) => entry.wireHash === first[index]!.wireHash),
);

// The two properties the ledger cannot survive losing.
{
  const lifecycle = projectLifecycleDefinition();
  const children = Object.values(lifecycle.steps).filter(
    (step) => (step as { kind?: string }).kind === "childWorkflow",
  );
  check("every stage is a child workflow", children.length === STAGES.length);

  for (const stage of STAGES) {
    const steps = stageDefinition(stage).steps as Record<string, { kind?: string }>;
    const gate = Object.values(steps).some((step) => step.kind === "awaitSignal");
    const bounded = Object.values(steps).some(
      (step) =>
        step.kind === "loop" &&
        (step as { maxIterations?: number }).maxIterations === MAX_REVISIONS,
    );
    if (!gate) check(`stage ${stage} ends at a human gate`, false);
    if (!bounded) check(`stage ${stage} loop is bounded`, false);
  }
  check("every stage ends at a human gate", true);
  check("every stage loop is bounded", true, `${MAX_REVISIONS} revisions`);
}

// §8: the body a specialist reads lives in the hub's own repo, not only in a
// table of ours. A row without a committed body is a job posting with no
// instructions behind it.
{
  const { deployDefinitionBodies, deployedPack } = await import("../apps/hub/src/hub-deploy.js");
  const { agentFor } = await import("@solutions-builder/app/kit");

  const stageDefinitions = second.filter((entry) => /\.stage\.\d+$/.test(entry.name));
  check("every stage has a definition to carry a body", stageDefinitions.length === STAGES.length);

  const bodies = stageDefinitions.map((entry) => ({
    definitionId: entry.id,
    systemPrompt: agentFor(Number(entry.name.split(".").at(-1)) as never).system,
  }));
  const written = await deployDefinitionBodies(bodies);
  check("each one commits", written.length === stageDefinitions.length);

  const packs = await Promise.all(bodies.map((body) => deployedPack(body.definitionId)));
  check(
    "and the hub can produce the pack a sidecar would pull",
    packs.length > 0 && packs.every((pack) => pack !== null && pack.bytes > 0),
    `${packs.filter((pack) => pack && pack.bytes > 0).length}/${packs.length} packs`,
  );
  check(
    "committed on the deploy ref",
    packs.length > 0 && packs.every((pack) => pack?.ref.includes("deploy")),
    packs[0]?.ref ?? "none",
  );

  // Two different stages must not share a body — the failure mode of writing
  // one prompt everywhere and calling nine definitions deployed.
  const shas = new Set(packs.map((pack) => pack?.commitSha));
  check("each stage carries its own body", shas.size === stageDefinitions.length, `${shas.size} distinct commits`);
}

console.log(`\nWorkflow smoke: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
