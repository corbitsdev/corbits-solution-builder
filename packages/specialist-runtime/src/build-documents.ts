/**
 * The two documents every built application ships (#733): a README for
 * whoever installs and runs it, and a user manual for whoever uses it.
 *
 * Stated once here, below any agent runtime, so the host's build packet,
 * the AGENTS.md seeded into the workspace, and the archive verification all
 * name the same files and the same rule.
 */
import type { VerificationItem } from "./delivery.js";

export const README_PATH = "README.md";
export const USER_MANUAL_PATH = "docs/USER-MANUAL.md";
/** Where the manual's pictures go, as PNG. */
export const MANUAL_IMAGES_DIR = "docs/manual";

export const DEFAULT_DOCUMENT_LANGUAGE = "American English";

/** The rule, as the coding agent reads it; `language` is the workspace's output language. */
export function buildDocumentsRule(language: string = DEFAULT_DOCUMENT_LANGUAGE): string {
  return [
    `Every build ships two documents, written in ${language}.`,
    ``,
    `${README_PATH}, at the top level, is for the person who installs and runs the application: an installer, a sysadmin or an IT person. It says how to run the application in development and in deployment; names every environment variable and any .env file, with what each value is and where it comes from; names the seed file or first-run step when there is one; says what the application needs from the systems around it (database, mail, accounts, network, credentials) and what must be declared or configured there; and says how to tell that it is running.`,
    ``,
    `${USER_MANUAL_PATH} is for the people who use the application. Write it in clear, easy-to-understand, non-technical prose: one section per screen or task, saying what the person sees and what to do. Put pictures of the screens in it. Make the pictures from the running application: capture each screen with a headless browser at 1280 pixels wide, draw a visible highlight (a rounded rectangle in one bright color, with a short label) around the area or button the step refers to, save each as a PNG under ${MANUAL_IMAGES_DIR}/, and reference it from the manual with a caption.`,
    ``,
    `Both documents describe what was built, never what was planned and dropped. They are part of the build: the archive is checked for them.`,
    ``,
    `A script the README or package.json tells anyone to run directly has a shebang line and its executable bit set: chmod +x it and commit it that way (git add --chmod=+x), so it runs as unpacked.`,
  ].join("\n");
}

/**
 * The verification items for the two documents, from the paths an archive
 * holds: `verified` when present, `missing` when not. Both are required, so
 * a build without them is recorded as incomplete.
 */
export function requiredDocumentItems(paths: ReadonlySet<string>): VerificationItem[] {
  return [README_PATH, USER_MANUAL_PATH].map((path) =>
    paths.has(path)
      ? { category: "docs", path, required: true, status: "verified", checkedBy: "tool" }
      : { category: "docs", path, required: true, status: "missing", checkedBy: "tool", detail: `not in the archive; every build ships ${path}` },
  );
}
