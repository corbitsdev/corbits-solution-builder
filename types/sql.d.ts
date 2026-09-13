/**
 * SQL files imported as text.
 *
 * The bundler resolves `import sql from "./x.sql" with { type: "text" }` and
 * embeds the contents, which is how the compiled single-file host carries the
 * vendored migrations. TypeScript has no such resolution, so the module shape
 * is declared here.
 */
declare module "*.sql" {
  const contents: string;
  export default contents;
}
