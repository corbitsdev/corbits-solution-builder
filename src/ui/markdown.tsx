/**
 * Markdown, rendered.
 *
 * A specialist's draft is a document a person has to read and judge. Showing it
 * as `## Problem statement` in a monospace block asks them to parse it first,
 * which is the opposite of the job.
 *
 * Written rather than pulled in, for one reason: the content comes from a model
 * and is therefore untrusted. Every character is escaped before any formatting
 * is applied, so there is no path by which markup in a draft becomes markup on
 * the page — no `dangerouslySetInnerHTML`, no raw-HTML passthrough, no
 * sanitiser to keep up to date. What is not handled below renders as text.
 */
import type { JSX, ReactNode } from "react";
import { DEL, END, INS } from "./revisions.js";

/**
 * Inline spans: code, bold, italic, with tracked changes threaded through them.
 * Formatting is matched first so a change that starts outside a bold run and
 * ends inside it still renders as bold; the change state carries across.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, longest markers first, so `**` never matches as two `*`.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  const state = { open: null as string | null };
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(...marked(text.slice(last, match.index), `${keyPrefix}-${index++}`, state));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      out.push(<code key={key}>{token.slice(1, -1).replace(MARKS, "")}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{marked(token.slice(2, -2), key, state)}</strong>);
    } else {
      out.push(<em key={key}>{marked(token.slice(1, -1), key, state)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(...marked(text.slice(last), `${keyPrefix}-${index}`, state));
  return out;
}

const MARKS = new RegExp(`[${INS}${DEL}${END}]`, "g");

/** Plain text with change marks, wrapped in ins/del; `state` carries an open run. */
function marked(text: string, keyPrefix: string, state: { open: string | null }): ReactNode[] {
  const out: ReactNode[] = [];
  const wrap = (run: string, key: string) => {
    if (run.length === 0) return;
    if (state.open === INS) out.push(<ins key={key}>{run}</ins>);
    else if (state.open === DEL) out.push(<del key={key}>{run}</del>);
    else out.push(run);
  };
  let run = "";
  let index = 0;
  for (const char of text) {
    if (char === INS || char === DEL || char === END) {
      wrap(run, `${keyPrefix}-${index++}`);
      run = "";
      state.open = char === END ? null : char;
    } else {
      run += char;
    }
  }
  wrap(run, `${keyPrefix}-${index}`);
  return out;
}

type Block =
  | { kind: "heading"; level: 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ...list });
      list = null;
    }
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    // Fenced code runs verbatim until its closing fence.
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // A draft's own `#` is a section within the page, never the page's title,
      // so the scale starts at h2 and stops at h4.
      const level = Math.min(4, Math.max(2, heading[1]!.length + 1)) as 2 | 3 | 4;
      blocks.push({ kind: "heading", level, text: heading[2]!.trim() });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: "quote", text: quote[1]! });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const item = (bullet ?? numbered)![1]!;
      if (list && list.ordered === ordered) list.items.push(item);
      else {
        flushList();
        list = { ordered, items: [item] };
      }
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parse(source);
  return (
    <div className="prose">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as "h2" | "h3" | "h4";
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case "list":
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, at) => (
                  <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, at) => (
                  <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>
                ))}
              </ul>
            );
          case "quote":
            return <blockquote key={key}>{inline(block.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={key} />;
          default:
            return <p key={key}>{inline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
