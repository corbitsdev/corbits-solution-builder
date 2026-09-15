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
- Prefer small changes with large effect. A change that grows `apps/hub`
  needs a reason.
- Keep going. Update `.beta/STATUS.md` as work lands so a usage cut loses
  nothing.

## Scoreboard
`apps/hub/src` vs `packages/*/src`, measured each iteration. Start: 21,132 / 3,570.
