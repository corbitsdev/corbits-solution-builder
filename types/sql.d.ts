/**
 * The vendored Interchange migrations, imported as text.
 *
 * Scoped to the migrations directory rather than declaring every `.sql` in the
 * repository: a mistyped or unintended SQL import elsewhere should still fail
 * to resolve rather than silently typecheck as a string. The pattern carries
 * the one wildcard TypeScript permits in an ambient module name.
 */
declare module "../../../vendor/interchange/packages/db/migrations/*.sql" {
  const contents: string;
  export default contents;
}
