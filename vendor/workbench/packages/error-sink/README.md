# @corbits/error-sink

The structured convention every catch block reports a failure to instead of
swallowing it (CL-6496 — the owner ruling this package exists to enforce):
one function, `reportError(error, context)`, that never throws and returns
a `refId` a person can quote to support. It redacts (see below) and
preserves the error's `.cause` chain, depth-capped so a cyclic or
unbounded chain can't blow up the logger.

## Why this isn't a second logger

The repo already had one logging concept before this package existed:
`@intx/log` (LogTape underneath), used from `getLogger([...])` /
`log.error(...)` across apps/hub, apps/sidecar, and a dozen packages —
65+ call sites. It already has a pluggable-sink seam (LogTape's own
`configureSync`/sinks) and universal runtime support (Node, Bun,
browsers). `@corbits/client-log`, by contrast, has four call sites, all
in `apps/web`, and exists only because `@intx/log` wasn't adopted there
yet — not because LogTape can't run in a browser.

So this package adds only what `@intx/log` was missing: a fixed
structured-error shape (`operation`, optional `tenantId`/`roomId`/
`agentId`, and a `refId`) plus a redaction pass, delivered through
`getLogger(["errors"])`. Reaching OTEL/Sentry later is a LogTape sink
registered once via `@intx/log`'s own `configureSync`/`setup` — no call
site of `reportError` changes when that happens.

New code should always go through `reportError` rather than calling
`log.error` directly. The repo's existing raw `log.error` call sites predate
this package and are grandfathered, not a pattern to copy — they don't get
the redaction pass below, the `refId`, or the structured context shape.

## What redaction does and doesn't catch

`redactText`/`redactExtra` (`src/redact.ts`) are a heuristic pass, not a
general-purpose secret scanner — the bar is "never ships an obvious secret
in a common shape," not "catches every possible one."

Caught:

- A `Bearer <token>` fragment or an `Authorization: <value>` header fragment
  anywhere in a string.
- Known provider key prefixes: `sk-`/`pk-`/`rk-`/`ghp-`/`gho-`/`ghu-`/`ghs-`
  and their underscore variants (`ghp_...`, as GitHub actually issues them).
- A raw JWT (`eyJ...eyJ...`. shape) even with no keyword nearby — the
  base64url header is distinctive enough to key off directly.
- `token=`, `secret=`, `password=`, `api_key=`, and similar assignments,
  whether in a URL's query string or in a free-text message — only the
  value becomes `[redacted]`, the param/field name stays.
- `code=` and `key=` specifically **only** when they appear as a URL query
  param (right after a literal `?` or `&`, e.g. an OAuth callback's
  `?code=...`). Elsewhere these two names are common non-secret shapes
  (`code=404`, logfmt's `code=DB_TIMEOUT`, a cache `key=user:1234:profile`)
  and are deliberately left untouched — see below.
- Any object key that itself looks credential-shaped (`token`, `secret`,
  `password`, `apiKey`, `cookie`, ...) is redacted wholesale, including when
  its value is an array or a nested object — `redactExtra` recurses through
  both.

Not caught, by design:

- A raw secret string with no recognizable prefix, keyword, or shape sitting
  under an unrelated key (e.g. a bare AWS access key in a field named
  `values`). There is no reliable heuristic for this that doesn't also flag
  ordinary IDs; put such values behind a credential-shaped key instead.
- `code=`/`key=` outside a URL query string. These two names are too
  ambiguous with everyday non-secret shapes (an HTTP status `code=404`,
  logfmt's `code=DB_TIMEOUT`, a cache `key=...`) to redact in free text
  without regularly destroying debugging context — a log nobody can read is
  a log nobody uses. If a call site genuinely has a bare secret under one of
  these names outside a URL, put it in `extra` under a credential-shaped
  key instead of interpolating it into the message string.
- Secrets embedded in non-string values (numbers, binary blobs) or inside a
  JSON-serialized string that isn't itself parsed back into an object.

## Retiring `@corbits/client-log`

Out of scope for this unit, but the plan: migrate `apps/web`'s four
`getLogger` call sites (`instant-agent-create.ts`, `auth-screen.tsx`,
`main.tsx`, `app-error-boundary.tsx`) onto `@intx/log` directly, confirm
LogTape's browser sink covers the same "visible in devtools" bar
`client-log`'s console mirror does, then delete `packages/client-log`.
Small enough for one follow-up PR; the only open question is whether
`client-log`'s in-memory ring buffer (for a future devtools panel) has
any real consumer yet, or can be dropped outright.
