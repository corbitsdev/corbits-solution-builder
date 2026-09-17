/**
 * The curated kit's skills as hub assets.
 *
 * A `SkillRecord` (`packages/solutions-builder/src/seed-kit.ts`) is one of §8's
 * versioned records; this is where that record becomes a platform row rather
 * than a value only this process can read. Each skill gets its own asset,
 * kind `skill`, holding a `SKILL.md` in the shape the hub's skill-kind
 * handler parses (`vendor/interchange/packages/hub-sessions/src/skill-kind.ts`:
 * a top-level directory named for the skill, containing `SKILL.md` whose
 * frontmatter `name` matches that directory).
 *
 * This asset is the record, not the seam a role's prompt is built from: a
 * workflow step's agent is defined once at render time with a static
 * `systemPrompt` string (see `lifecycle-source.ts`'s `renderedPrompt`), which
 * already carries the skill's instructions. There is no per-turn session
 * mount that reads this asset back into an agent — inventing one would be a
 * second place the same text is read from, not a seam the platform has.
 */
import type { Transport } from "@intx/hub-client";
import type { SkillRecord } from "@solutions-builder/app/kit";
import { kitSeed } from "@solutions-builder/app/seed-kit";
import { assetsFor, readWorkflowSourceBlob, writeWorkflowSourceTree } from "./hub.js";
import { treeDigest } from "./workflow-closure.js";

const DIGEST_PATH = "digest.sha256";

function skillMarkdown(skill: SkillRecord): string {
  // The frontmatter's `description` is a short line the hub's schema caps at
  // 1024 characters and forbids `<…>` placeholders in; a skill that carries
  // one sets it, and otherwise the instructions serve — truncated, since they
  // can run longer than that (`interchange-platform` does), so the full text
  // is the document body and the description is a bounded summary of it.
  const description =
    skill.description ??
    (skill.instructions.length <= 1024 ? skill.instructions : `${skill.instructions.slice(0, 1000)}…`);
  const frontmatter = [
    "---",
    `name: ${skill.key}`,
    `description: ${JSON.stringify(description)}`,
    `version: ${skill.version}`,
    `tools: ${JSON.stringify(skill.tools)}`,
    "---",
    "",
  ].join("\n");
  return `${frontmatter}\n${skill.instructions}\n`;
}

function skillFiles(skill: SkillRecord): Record<string, string> {
  return { [`${skill.key}/SKILL.md`]: skillMarkdown(skill) };
}

/**
 * Makes sure every skill the curated kit names exists as a `skill` asset,
 * at the tree the kit currently generates. Safe to call on every install:
 * an asset already at the current digest is a read, not a write.
 */
export async function ensureSkillAssets(transport: Transport, tenantId: string): Promise<void> {
  const assets = assetsFor(transport, tenantId);
  const seed = kitSeed();
  const existing = await assets.list("skill");
  for (const skill of seed.skills) {
    const found = existing.find((asset) => asset.name === skill.key);
    const assetId = found ? found.id : (await assets.create({ kind: "skill", name: skill.key, displayName: skill.key })).id;
    const files = skillFiles(skill);
    const digest = treeDigest(files);
    const head = await readWorkflowSourceBlob(transport, tenantId, assetId, DIGEST_PATH);
    if (head === `${digest}\n`) continue;
    await writeWorkflowSourceTree(transport, tenantId, {
      assetId,
      files: { ...files, [DIGEST_PATH]: `${digest}\n` },
      message: `Skill ${skill.key} generated from the curated kit`,
    });
  }
}
