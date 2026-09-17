/** POSIX path stand-in so Vite can bundle `@intx/*` dist that imports `node:path`. */

export const sep = "/";

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

export function normalize(p: string): string {
  const absolute = p.startsWith("/");
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (absolute) return joined.length === 0 ? "/" : `/${joined}`;
  return joined.length === 0 ? "." : joined;
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

export function resolve(...parts: string[]): string {
  let acc = "";
  for (const part of parts) {
    if (part.startsWith("/")) acc = part;
    else acc = acc.length === 0 ? part : `${acc}/${part}`;
  }
  const normalized = normalize(acc.startsWith("/") ? acc : `/${acc}`);
  return normalized.length === 0 ? "/" : normalized;
}

export function dirname(p: string): string {
  const normalized = normalize(p);
  if (normalized === "/") return "/";
  const i = normalized.lastIndexOf("/");
  if (i <= 0) return "/";
  return normalized.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  const normalized = normalize(p);
  const base = normalized === "/" ? "" : (normalized.split("/").pop() ?? "");
  if (ext && ext.length > 0 && base.endsWith(ext) && base !== ext) return base.slice(0, -ext.length);
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

export const posix = { sep, isAbsolute, normalize, join, resolve, dirname, basename, extname };

export default { ...posix, posix };
