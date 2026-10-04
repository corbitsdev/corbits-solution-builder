import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { seniorEngineerSecurity } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${seniorEngineerSecurity.system}\n\n${skillTextFor(seniorEngineerSecurity)}`;
