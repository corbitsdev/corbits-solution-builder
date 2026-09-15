# Standing mandate (operator, 2026-09-15)

`apps/hub` and `apps/sidecar` as vanilla as possible. Logic lives in
workflows, tools, skills and agents under `packages/*`. **The client drives
the experience, not the hub.** Anything in the hub that shapes what a person
sees or does next is in the wrong place.

- Findings become Linear issues (Corbits team, Solutions Builder Alpha).
- Work happens in worktrees off `internal-beta`, as PRs, merged into
  `internal-beta`. Never into main.
- `vendor/interchange` is untouchable. Interchange bugs get flagged for the
  operator, not patched here.
- Lean on the Ollama models at the Tailscale endpoint for agent work.
- **A running workflow does not phone home.** Anything a workflow or agent
  needs to do, it should carry — as a tool in its deployed closure, running
  in the sidecar. A hub endpoint that exists only so a workflow can ask the
  host to do something is the shape to remove, not to tidy.
- Prefer small changes with large effect. A change that grows `apps/hub`
  needs a reason.
- Never `git stash`. Worktrees share one stash stack, so a stash in one
  agent's worktree can swallow another's uncommitted work. Commit a WIP
  instead.
- Never run `bun run check` concurrently with another agent's. They race on
  `vendor:build` and produce failures that are not real.
- Keep going. Update `.beta/STATUS.md` as work lands so a usage cut loses
  nothing.

## Scoreboard
`apps/hub/src` vs `packages/*/src`, measured each iteration. Start: 21,132 / 3,570.
