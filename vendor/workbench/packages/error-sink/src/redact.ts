// Strips obvious secrets before a report reaches any transport (CL-6496):
// a key that looks like a credential is replaced outright, and every
// string value -- messages, stack traces, anything nested in `extra` --
// is scanned for bearer tokens and authorization-header fragments.
// Heuristic, not a full secret-scanning engine: the bar is "never ships
// an obvious secret", not "catches every possible one".
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|api[-_]?key|apikey|credential|authorization|cookie/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /bearer\s+\S+/gi,
  /authorization\s*:\s*\S+/gi,
  // Provider key prefixes use either a hyphen (OpenAI's `sk-...`) or an
  // underscore (GitHub's `ghp_...`) -- both must match.
  /\b(sk|pk|rk|ghp|gho|ghu|ghs)[-_][a-z0-9]{8,}\b/gi,
  // A raw JWT (header.payload.signature) carries no keyword prefix at all,
  // but its base64url header always starts with the literal `eyJ` (base64
  // of `{"`), which is distinctive enough to key off heuristically.
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g,
];

// A value's character set once past `name=`: covers hex/base64/JWT-shaped
// tokens without running past the value into unrelated trailing text (a
// closing paren, a stack-frame's `:12:5)`, ...).
const ASSIGNMENT_VALUE = "[\\w.+/=%-]+";

// `token=`, `access_token=`, ... assignments: covers both a raw OAuth
// callback URL's query string (`?access_token=...`) and the same shape
// typed into a free-text error message. Only the value is replaced so the
// param name -- and the rest of the URL/message -- stays readable for
// debugging. These names are unambiguous: outside of a credential they
// don't ordinarily show up as a bare `name=value` assignment at all.
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(access_token|refresh_token|id_token|api[-_]?key|apikey|secret|password|passwd|token|credential)(\\s*=\\s*)(${ASSIGNMENT_VALUE})`,
  "gi",
);

// `code` and `key` are NOT unambiguous -- `code=404`, logfmt's
// `code=DB_TIMEOUT`, and `key=user:1234:profile` are everyday non-secret
// shapes. The only place they reliably mean "secret" is a URL query string
// (an OAuth `code`, a `key=` API credential passed as a param), so these
// two are scoped to right after a literal `?` or `&`.
const QUERY_PARAM_SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `([?&])(code|key)(\\s*=\\s*)(${ASSIGNMENT_VALUE})`,
  "gi",
);

export function redactText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  redacted = redacted.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, name: string, separator: string) =>
      `${name}${separator}[redacted]`,
  );
  redacted = redacted.replace(
    QUERY_PARAM_SENSITIVE_ASSIGNMENT_PATTERN,
    (_match, prefix: string, name: string, separator: string) =>
      `${prefix}${name}${separator}[redacted]`,
  );
  return redacted;
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(key, entry));
  }
  if (value !== null && typeof value === "object") {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

function redactRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = redactValue(key, value);
  }
  return redacted;
}

export function redactExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (extra === undefined) return undefined;
  return redactRecord(extra);
}
