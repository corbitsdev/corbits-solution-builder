/**
 * The curated kit as versioned records — BUILD_PLAN_V3 §8.
 *
 * §8 asks for "versioned native Interchange records, not a parallel agent
 * runtime". The kit was a TypeScript array for most of this build, which is a
 * parallel runtime by another name: nothing outside the process could read it,
 * version it, or say which prompt a given draft came from.
 *
 * The rules checked here are the ones §8 states outright, and each is a rule
 * whose breach is invisible at runtime — an agent quietly holding a write
 * grant looks exactly like one that does not.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../apps/hub/db.js";
import { prepareDatabase } from "../apps/hub/migrate.js";
import { seedKit, storedKit } from "../apps/hub/kit-records.js";
import { kitSeed } from "@solutions-builder/app/seed-kit";
import { AGENT_KIT } from "@solutions-builder/app/kit";
import { baseTemplate, SLOTS, violationsIn } from "@solutions-builder/app/template";
import { knownCompatibility } from "../apps/hub/compatibility.js";

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

const seed = kitSeed();

// --- The shapes §8 names ---
check("every role has a prompt record", seed.prompts.length === AGENT_KIT.length);
check("every role has an agent seed", seed.agents.length === AGENT_KIT.length);
{
  // CL-7600: whoever interviews asks in plain words and offers likely answers.
  const interviewing = AGENT_KIT.filter((role) => role.system.includes("What I need from you"));
  const silent = interviewing.filter((role) => !role.system.includes("Offer two or three likely answers"));
  check(
    "every interviewing specialist offers likely answers in plain words",
    interviewing.length > 0 && silent.length === 0,
    silent.map((role) => role.id).join(", "),
  );
}
{
  // CL-7603: no quota of questions; ask what matters, and none is allowed.
  const quota = AGENT_KIT.filter((role) => !role.system.includes("none is a fine answer"));
  check("no specialist targets a number of questions", quota.length === 0, quota.map((role) => role.id).join(", "));
}
check("§8's ten default skills are present", seed.skills.length >= 10, `${seed.skills.length} skills`);
check("the three stable directors exist", seed.directors.length === 3, seed.directors.map((d) => d.key).join(", "));
check(
  "every director key is the one §8 fixes",
  seed.directors.every((director) =>
    ["sb-facilitator", "sb-specialists", "sb-supervisor"].includes(director.key),
  ),
);
check(
  "prompt keys follow the sb-prompt-*-v1 form",
  seed.prompts.every((prompt) => /^sb-prompt-[a-z-]+-v1$/.test(prompt.key)),
  seed.prompts.find((p) => !/^sb-prompt-[a-z-]+-v1$/.test(p.key))?.key ?? "",
);

// --- The rules whose breach is invisible ---
{
  // A binding names a purpose. A vendor model id here is how switching
  // providers becomes an edit to ten prompts.
  const vendor = seed.models.filter((model) =>
    /gpt|claude|grok|llama|gemini|o[1-9]-/i.test(`${model.key} ${model.purpose}`),
  );
  check("no binding names a vendor model", vendor.length === 0, vendor.map((m) => m.key).join(", "));
}
{
  // §8: "no agent gets human approval authority from a workflow-write tool".
  const writeTools = new Set(
    seed.tools.filter((tool) => tool.mode === "write").map((tool) => tool.key),
  );
  const deciders = seed.agents.filter((agent) =>
    agent.toolKeys.some((key) => writeTools.has(key)),
  );
  const allowed = new Set(["sb-agent-build-supervisor"]);
  check(
    "only the supervisor holds a write tool",
    deciders.every((agent) => allowed.has(agent.key)),
    deciders.map((a) => a.key).join(", "),
  );
}
{
  // The guide orients and must not be able to alter an artifact.
  const guide = seed.agents.find((agent) => agent.agent === "product-guide");
  check(
    "the product guide holds no propose or write tool",
    guide?.toolKeys.every((key) => {
      const tool = seed.tools.find((entry) => entry.key === key);
      return tool?.mode === "read";
    }) === true,
    guide?.toolKeys.join(", ") ?? "no guide",
  );
}
{
  // Every tool resolves to a declared grant, and every grant is declared.
  const grantKeys = new Set(seed.grants.map((grant) => grant.key));
  const dangling = seed.tools.filter((tool) => !grantKeys.has(tool.grantKey));
  check("every tool names a declared grant", dangling.length === 0, dangling.map((t) => t.key).join(", "));
  const skillTools = new Set(seed.skills.flatMap((skill) => skill.tools));
  const toolKeys = new Set(seed.tools.map((tool) => tool.key));
  const missing = [...skillTools].filter((key) => !toolKeys.has(key));
  check("every skill names a declared tool", missing.length === 0, missing.join(", "));
}
{
  const panel = seed.agents.filter((agent) => agent.panelKey !== null);
  check("the four principals are panel members", panel.length === 4, `${panel.length}`);
  check(
    "and each carries its own model binding",
    new Set(panel.map((agent) => agent.modelKey)).size === 4,
  );
}

// --- Persistence, and its versioning ---
{
  const dataDir = await mkdtemp(join(tmpdir(), "solutions-builder-kit-"));
  await prepareDatabase(await openDatabase(`${dataDir}/pglite`));

  const first = await seedKit();
  check("a fresh workspace seeds the whole kit", first.every((entry) => entry.created));
  check("every record lands at version 1", first.every((entry) => entry.version === 1));

  const again = await seedKit();
  check("seeding again writes nothing", again.every((entry) => !entry.created));
  check(
    "and versions do not move",
    again.every((entry) => entry.version === 1),
    again.find((entry) => entry.version !== 1)?.key ?? "",
  );

  const stored = await storedKit();
  check("the stored kit is the seeded kit", stored.length === first.length, `${stored.length}`);
  check(
    "every kind is represented",
    new Set(stored.map((row) => row.kind)).size === 8,
    [...new Set(stored.map((row) => row.kind))].join(", "),
  );
}

// --- §9's template rules, which a future template will be written against ---
{
  const base = baseTemplate();
  check("the base template is valid", violationsIn(base).length === 0, violationsIn(base).join(" "));
  check("it fixes all nine gates", base.gates.length === 9);
  check(
    "stage 7 leaves on cost approval",
    base.gates.find((gate) => gate.stage === 7)?.command === "cost.approve",
  );
  check("every slot §9 names is filled", base.slots.length === SLOTS.length, `${base.slots.length}`);

  // Nobody writes a template meaning to remove a gate. They write one meaning
  // to add a step and take a shortcut, so each shortcut is checked.
  const dropped = { ...base, gates: base.gates.filter((gate) => gate.stage !== 5) };
  check("removing a stage is refused", violationsIn(dropped).length > 0);

  const reordered = {
    ...base,
    gates: [base.gates[1]!, base.gates[0]!, ...base.gates.slice(2)],
  };
  check("reordering the stages is refused", violationsIn(reordered).some((problem) => problem.includes("out of order")));

  const weakened = {
    ...base,
    gates: base.gates.map((gate) =>
      gate.stage === 7 ? { ...gate, authorities: [] } : gate,
    ),
  };
  check(
    "weakening an approval is refused",
    violationsIn(weakened).some((problem) => problem.includes("drops the budget_approver")),
  );

  const rerouted = {
    ...base,
    gates: base.gates.map((gate) =>
      gate.stage === 7 ? { ...gate, command: "stage.approve" } : gate,
    ),
  };
  check(
    "bypassing the stage-7 interlock is refused",
    violationsIn(rerouted).some((problem) => problem.includes("the ledger says cost.approve")),
  );

  // What a template IS allowed to do must still pass.
  const extended = {
    ...base,
    slots: base.slots.map((binding) =>
      binding.slot === "surface-design"
        ? { ...binding, addedSteps: ["simulator-screenshot", "device-test"] }
        : binding,
    ),
    gates: base.gates.map((gate) =>
      gate.stage === 9
        ? { ...gate, authorities: [...gate.authorities, "security_reviewer"] }
        : gate,
    ),
  };
  check(
    "adding steps and approvers is allowed",
    violationsIn(extended).length === 0,
    violationsIn(extended).join(" "),
  );
}

// --- §4: the compatibility matrix says what is true, including what is not ---
{
  const rows = knownCompatibility();
  check("the matrix is recorded", rows.length > 0, `${rows.length} dependencies`);
  check(
    "every row carries evidence",
    rows.every((row) => row.evidence.trim().length > 0),
  );
  check(
    "every status is one §4 allows",
    rows.every((row) => ["verified", "unavailable", "planned-only"].includes(row.status)),
  );
  // The row that matters: §4 says a missing launch primitive blocks the gate
  // depending on it, and a matrix that claimed everything was verified would
  // be the "fake substitute" it forbids.
  const blocked = rows.filter(
    (row) => row.classification === "launch-required" && row.status !== "verified",
  );
  check(
    "unproven launch dependencies are named as unproven",
    blocked.length > 0,
    blocked.map((row) => row.dependency).join("; "),
  );
  check(
    "and each says what it blocks",
    blocked.every((row) => row.limitations.length > 0),
  );
}

// The roles that decide whether something gets built twice carry the guidance
// for not doing it. This whole build was a demonstration of the failure.
{
  const planners = ["architect", "build-supervisor", "senior-engineer-application"];
  for (const id of planners) {
    const agent = seed.agents.find((entry) => entry.agent === id);
    check(
      `${id} carries the platform guidance`,
      agent?.skillKeys.includes("interchange-platform") === true,
      agent?.skillKeys.join(", ") ?? "no agent",
    );
  }
  const skill = seed.skills.find((entry) => entry.key === "interchange-platform");
  check(
    "and it names the primitives rather than gesturing at them",
    ["workflow", "grant", "credential", "mail", "tenant", "principal"].every((word) =>
      (skill?.instructions ?? "").toLowerCase().includes(word),
    ),
  );
}

console.log(`\nKit smoke: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
