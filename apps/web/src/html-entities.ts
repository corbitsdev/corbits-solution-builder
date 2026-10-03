const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** A numeric entity's character, or U+FFFD for one no string can hold (out of
 *  range, a surrogate half, or NUL): `String.fromCodePoint` throws on those. */
function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(value);
}

/** Numeric and common named HTML/XML entities, decoded in one pass; an unknown name is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const hex = name[1] === "x" || name[1] === "X";
    return codePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}
