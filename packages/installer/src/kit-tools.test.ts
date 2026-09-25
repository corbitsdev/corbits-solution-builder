/**
 * The kit may only name tools a specialist is actually deployed with. The app
 * package cannot import the tool packages (they depend on it), so the check
 * lives here, beside the installer that ships them.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_NAMES as POSIX_TOOL_NAMES } from "@intx/tools-posix";
import { AGENT_KIT } from "@solutions-builder/app/kit";
import { SPECIALIST_TOOLS, kitSeed } from "@solutions-builder/app/seed-kit";
import { BUILD_STAGE, DELIVERY_STAGE, PACKAGE_STAGE } from "@solutions-builder/app/specialist-source";
import { TOOL_NAME as RENDER_DECK } from "@solutions-builder/tools-deck/sidecar-bundle";
import { DELIVER_TOOL_NAME, TOOL_NAME as DELIVERY_STATUS } from "@solutions-builder/tools-delivery/sidecar-bundle";
import { TOOL_NAME as PUBLISH_WORKSPACE } from "@solutions-builder/tools-delivery/publish-workspace";

describe("the kit's tool names", () => {
  test("SPECIALIST_TOOLS matches the tool packages' own names", () => {
    const names = (list: readonly string[]): string[] => [...list].sort();
    expect(names(SPECIALIST_TOOLS.deck)).toEqual([RENDER_DECK]);
    expect(names(SPECIALIST_TOOLS.posix)).toEqual(names(Object.values(POSIX_TOOL_NAMES)));
    expect(names(SPECIALIST_TOOLS.publishWorkspace)).toEqual([PUBLISH_WORKSPACE]);
    expect(names(SPECIALIST_TOOLS.delivery)).toEqual(names([DELIVERY_STATUS, DELIVER_TOOL_NAME]));
  });

  test("a role's skills name only tools its stage's deployment carries", () => {
    // Mirrors `specialistEntrySource`'s per-stage tool imports; stage 5's
    // per-audience deployments carry the deck, its primary one carries none.
    const toolsByStage: Record<number, readonly string[]> = {
      [PACKAGE_STAGE]: SPECIALIST_TOOLS.deck,
      [BUILD_STAGE]: [...SPECIALIST_TOOLS.posix, ...SPECIALIST_TOOLS.publishWorkspace],
      [DELIVERY_STAGE]: SPECIALIST_TOOLS.delivery,
    };
    for (const agent of kitSeed().agents) {
      const role = AGENT_KIT.find((entry) => entry.id === agent.agent);
      const carried = new Set((role?.stages ?? []).flatMap((stage) => toolsByStage[stage] ?? []));
      const stray = agent.toolKeys.filter((tool) => !carried.has(tool));
      expect({ agent: agent.agent, stray }).toEqual({ agent: agent.agent, stray: [] });
    }
  });

  test("every skill names only real tools", () => {
    const real = new Set<string>(Object.values(SPECIALIST_TOOLS).flat());
    for (const skill of kitSeed().skills) {
      for (const tool of skill.tools) expect({ skill: skill.key, tool, real: real.has(tool) }).toEqual({ skill: skill.key, tool, real: true });
    }
  });
});
