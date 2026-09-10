/** Vite resolves an SVG import to its emitted URL. */
declare module "*.svg" {
  const url: string;
  export default url;
}
