# Queries

How the interface reads from the hub. `@tanstack/react-query` holds every
read; `client.ts` is the one `QueryClient`, `keys.ts` is the one place a
key is spelled.

## The rule

A clock is a backstop of 30 s or more, never the mechanism; the stream
invalidates. The mailbox and inbox streams the app already holds open are
where a reply, a run event or a decision first shows up, so that is what
marks a query stale. Nothing refetches in a hidden tab
(`refetchIntervalInBackground: false`); a return to the tab refetches what
is stale (`refetchOnWindowFocus: true`).

## Keys

One entry per hub resource in `keys.ts`, as `as const` tuples. A resource
with instances has `all` (the prefix, for invalidating every instance) and
`of(...)` (one instance). A write that changes a resource invalidates its
prefix in `onSuccess`; a stream event invalidates the instance it names.
Nothing outside `keys.ts` writes a key literal.

## Not migrated, on purpose

- One-shot ensures with progress callbacks (`client.ts` `ensureStageAgent`
  and `ensureProjectWorkflow` and their in-flight memos). They stay; their
  resolve invalidates the matching keys.
- Wait-until loops after a write (`stage-approval.ts` `pollView`,
  `adoption-replay.ts`, `use-workflow-view.ts`'s stage-0 wait,
  `audiences.tsx`'s reply wait). They are request round-trips, not cached
  reads, and belong in the call that made the write.
- The advisory watchers (`use-advisory.ts`): a send, a reply deadline and
  a failure budget, not a cached read.
- Pure UI clocks (`build.tsx`'s elapsed and timeout ticks).
- Binary caches (`deck-images.ts`).
- The SSE streams themselves.
