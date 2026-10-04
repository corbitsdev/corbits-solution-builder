import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { buildSupervisor } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${buildSupervisor.system}\n\n${skillTextFor(buildSupervisor)}`;
