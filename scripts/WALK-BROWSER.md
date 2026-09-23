# walk-browser

A repeatable real-browser walk of Solution Builder through all nine stages
against a local OpenAI-compatible model.

Boots an isolated host (fresh temp data dir, OS-assigned port — never 4880),
drives `agent-browser` through sign-up, onboarding, project creation and
stages 1-9, and writes compact per-step records instead of raw page dumps.

## Usage

```
bun run ui:build   # once, or after any web/UI change
scripts/walk-browser.sh
```

or via the package script:

```
bun run walk:browser
```

### Inputs (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `WALK_MODEL_BASE_URL` | `https://thegreataxios-home-studio.tail87f5aa.ts.net/v1` | OpenAI-compatible base URL |
| `WALK_MODEL_API_KEY` | `ollama` | its API key |
| `WALK_MODEL` | `gpt-oss:20b` | model name (informational; the provider serves whatever it discovers) |
| `WALK_BRIEF` | `scripts/walk-browser-brief.md` | path to the opening problem statement |
| `WALK_RESUME_STAGE` | `0` (start fresh) | resume the stage loop at this stage number (only meaningful with `WALK_KEEP_HOST=1` and a project already open) |
| `WALK_END_STAGE` | `9` | stop after this stage |
| `WALK_STAGE_TIMEOUT_S` | `900` | per-stage wait budget |
| `WALK_STAGE8_TIMEOUT_S` | `2400` (40 min) | wait budget for stage 8's build attempt specifically |
| `WALK_OUT_DIR` | a fresh `/tmp/walk-browser-*` dir | where `walk.jsonl`, `defects.jsonl` and `shots/` land |
| `WALK_KEEP_HOST` | unset | if `1`, leaves the host running after the walk (or a blocker) for inspection; prints only the masked origin, never the token |

### Outputs

- `$WALK_OUT_DIR/walk.jsonl` — one record per step: `{stage, action, outcome, ms}`.
- `$WALK_OUT_DIR/defects.jsonl` — one record per defect: `{stage, expected, observed, screenshot, severity}` (`severity` is `blocker`, `major` or `minor`).
- `$WALK_OUT_DIR/shots/*.png` — screenshots taken at defects and stage checkpoints.

On a blocker the script screenshots, records the defect, and exits non-zero.
It never fakes progress past a stage it could not verify.

Stage 8 clicks "Start the build attempt", then grants "Allow for this build"
on the first pending `run_shell` approval — a standing grant on that run for
that tool name, so later commands in the same build never need re-approval —
and waits (up to `WALK_STAGE8_TIMEOUT_S`) for a published build archive
before approving; it never clicks "Approve and continue" on a reply with no
evidence. Stage 9 accepts the `deliver` approval, downloads the delivered
archive, and unpacks it into a temp dir under `WALK_OUT_DIR` to record its
file tree and whether a `package.json` and real source files are present —
this fails loudly (non-zero exit, `blocker` defect) if stage 8 produced no
usable archive.

### Safety

- Host data dir: a fresh `mktemp -d` outside the repo, removed on exit (unless `WALK_KEEP_HOST=1`).
- Host port: `--port 0` (OS-assigned), so it never collides with a host another session is running (in particular, never 4880).
- The launch URL's token is never printed or logged; only the masked origin appears in output.
- On exit (success, failure, or signal) the script kills the host process and the `agent-browser` session it opened, and warns if a host process for its own data dir is still alive.

## Baseline 2026-09-19, internal-beta `b21c891802d4e5c05caca61e953d3b274002bd6a`

<!-- filled in after the timed baseline run -->
