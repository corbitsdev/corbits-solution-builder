# Contributing

## Branching

Branch off `main` with a short, descriptive name in the `<type>/<short-description>`
form used throughout this repo's history (e.g. `fix/settings-write-race`,
`feat/build-worker-setting`).

## Opening a pull request

Open the PR against `main`. `bun run check` runs in CI on every pull request
(see `.github/workflows/check.yml`) and must pass before the PR is merged; run
it locally first (see AGENTS.md for what it covers).

## Commit messages

Follow Conventional Commits 1.0.0 (https://www.conventionalcommits.org/en/v1.0.0/).

- Format: `<type>(<scope>): <description>` — scope is the component, e.g.
  `feat(executor)`, `fix(nameref)`, `perf(glob)`, `docs(release)`.
- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`,
  `chore`, `style`. Breaking changes: append `!` after the type/scope or add a
  `BREAKING CHANGE:` footer.
- Historically this repo used a bare `component: description` prefix
  (`executor:`, `nameref:`); new commits keep the component as the scope and
  lead with the type.
- Releases: `chore(release): perfi X.Y.Z`; release notes: `docs(release): add
  perfi X.Y.Z release notes`.
- Never add a `Co-Authored-By` trailer to any commit, PR, gh issue, or any other artifact
