/**
 * The platform skills, imported as text.
 *
 * Scoped to the platform-skills directory rather than declaring every `.md`
 * in the repository: a mistyped or unintended Markdown import elsewhere
 * should still fail to resolve rather than silently typecheck as a string.
 * The pattern carries the one wildcard TypeScript permits in an ambient
 * module name, matched against the specifier as the importer writes it.
 */
declare module "./platform-skills/*.md" {
  const contents: string;
  export default contents;
}
