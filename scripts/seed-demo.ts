/**
 * Seeds a demonstration project so the app opens onto something real.
 *
 * Every row it writes goes through the same store and engine the product uses —
 * there is no fixture path and no privileged write. What you see in the window
 * is what the host durably holds.
 *
 * The artifacts are written by hand rather than drafted by a model so the seed
 * works with no provider connected. Connect one and draft a new version to see
 * the specialists.
 *
 * Usage: bun scripts/seed-demo.ts
 */
import { openDatabase } from "../src/host/db/client.js";
import { prepareDatabase } from "../src/host/db/migrate.js";
import { createProject, projectDetail, writeArtifact } from "../src/host/store/projects.js";
import { execute } from "../src/host/engine.js";
import { drainOutbox } from "../src/host/outbox.js";
import { newId } from "../src/host/ids.js";
import { databaseDirectory } from "../src/host/paths.js";
import type { ArtifactKind } from "../src/contracts/domain.js";
import type { Command, Stage } from "../src/contracts/ledger.js";

const ACTOR = { principalId: "p_owner", displayName: "You" };

const host = await openDatabase(databaseDirectory());
await prepareDatabase(host);

async function command(type: Command, projectId: string, payload: Record<string, unknown>) {
  const outcome = await execute({
    type,
    actor: ACTOR,
    projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload,
  });
  await drainOutbox();
  return outcome;
}

const CONTENT: Record<number, { kind: ArtifactKind; title: string; body: string }> = {
  1: {
    kind: "problem_brief",
    title: "Problem brief",
    body: `# Problem brief

## Problem statement
Playing chess against an engine is not fun. Stockfish wins in twenty moves and
teaches nothing; the "easy" levels blunder in ways no human would, which is
just as unenjoyable in a different direction.

## Who is affected
One player, intermediate, roughly 1200 rated. Plays a few evenings a week.

## What happens today
Opens an engine app, loses, closes it. No progression, no explanation of what
went wrong.

## Pain, frequency and cost
Two or three abandoned sessions a week. The cost is not money; it is that a
hobby is quietly being given up.

## What a fix would be worth
Enough to justify a small desktop app. No budget for a subscription.

## Success criteria
- A game that is close rather than one-sided.
- After a loss, a plain-English explanation of the moment it turned.
- Runs offline on one Mac.

## Unknowns and risks
- Whether "close game" can be achieved without the opponent playing obviously
  badly. This is the central design risk.
- Assumption, not fact: the player wants to improve rather than only to win.`,
  },
  2: {
    kind: "solution_constraints",
    title: "Solution constraints",
    body: `# Solution constraints

## Solution form
Desktop application. Excluded: hosted web (offline is a stated criterion), CLI
(the artifact is a board), mobile (not asked for).

## Target platforms and environments
macOS 13+ on Apple silicon. One machine.

## Privacy and data policy
Local only. Game history stays on the machine. No account.

## Integrations and credentials
None required. If move explanation uses a model, it must be a local endpoint or
an explicitly configured key — never a silent cloud call.

## Non-goals
Online play, ratings ladders, opening databases, mobile.

## Unknowns
Whether the explanation feature can run locally at acceptable latency.`,
  },
  3: {
    kind: "chosen_approach",
    title: "Chosen approach",
    body: `# Solution proposal

## Approach A — strength-matched engine with post-game review
### How it works
A conventional engine, deliberately limited by search depth and a blunder model
tuned to the player's recent results, plus a review pass that names the single
move where the evaluation swung most.

### Fit against the brief
Directly targets "close rather than one-sided" and "explain the moment it
turned".

### Trade-offs
Strength matching is the hard part and will need iteration against real games.

### Risks
A badly tuned blunder model reads as an opponent playing stupidly, which is the
failure mode the brief explicitly names.

## Approach B — teaching-first, fixed weak opponent
Simpler, but a fixed opponent stops being interesting within weeks.

## Comparison
A costs more to tune; B is cheaper and worse at the stated criterion.

## Recommendation
Approach A. The brief's central criterion is the close game, and B cannot hold
it as the player improves.`,
  },
};

const created = await createProject({
  title: "Chess tutor",
  owner: ACTOR,
  policy: {
    costTolerancePercent: 12,
    costToleranceAbsolute: 2100,
    audiences: [
      { name: "Project owner", role: "project_owner" },
      { name: "Budget owner", role: "budget_approver" },
    ],
    audienceQuorum: 2,
    allowExternalProviders: true,
  },
});
console.log(`Created project ${created.projectId}`);

// Stages 1 and 2 are approved; stage 3 is left waiting, so the app opens onto a
// real decision rather than an empty queue.
for (const stage of [1, 2, 3] as Stage[]) {
  const detail = await projectDetail(created.projectId, ACTOR.principalId);
  const run = detail.current!;
  const entry = CONTENT[stage]!;
  const node = await writeArtifact(
    {
      projectId: created.projectId,
      branchId: created.branchId,
      kind: entry.kind,
      title: entry.title,
      content: entry.body,
      mediaType: "text/markdown",
      sourceVersionIds: detail.nodes
        .filter((candidate) => candidate.supersededByNodeId === null)
        .map((candidate) => candidate.id),
      provenance: { producer: "human", runId: run.id },
    },
    ACTOR,
  );
  const version = {
    artifactId: node.artifactId,
    versionId: node.nodeId,
    contentHash: node.contentHash,
  };
  await command("stage.submit", created.projectId, { runId: run.id, versions: [version] });
  if (stage < 3) {
    await command("stage.approve", created.projectId, { runId: run.id, versions: [version] });
    console.log(`  stage ${stage} approved`);
  } else {
    console.log(`  stage ${stage} left waiting for your decision`);
  }
}

const final = await projectDetail(created.projectId, ACTOR.principalId);
console.log(
  `\nOpen the app. ${final.waits.length} decision is waiting: ` +
    `${final.waits[0]?.title ?? "none"}`,
);
await host.close();
