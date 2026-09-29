import { Children, isValidElement, type ReactNode } from "react";

/**
 * The words a control shows, read off its children: strings and numbers,
 * through fragments and elements, icons and the like contributing nothing.
 * What a loading control says it is doing ("Writing…", "Save slides
 * (.pptx)") is what the busy strip repeats under its clock when the control
 * names nothing more specific (#223). Null when the control shows no words.
 */
export function controlText(children: ReactNode): string | null {
  const words: string[] = [];
  const walk = (node: ReactNode): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node).trim();
      if (text) words.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
      Children.forEach(node.props.children, walk);
    }
  };
  walk(children);
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}
