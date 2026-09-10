# Working in this repository

## Verify before asserting

`bun run check` is the gate: ledger consistency, dependency boundaries,
typecheck, and the nine-stage loop smoke. Run it before claiming anything works.
Green does not mean the product is right - drive the app for anything a person
would see.

## The rules the code keeps

These are enforced by `scripts/check-ledger.ts` and `scripts/check-boundaries.ts`.
If you need to break one, the honest move is to change the checker deliberately
and say why, not to route around it.

- **One state machine.** `packages/solutions-builder/ledger.ts` is the contract.
  `apps/hub/guard.ts` is the only place it is enforced. `apps/hub/engine.ts` is
  the only place a run's state is written.
- **The app package depends on nothing in the apps.** `packages/solutions-builder/`
  imports only the workflow authoring surface and the platform's types.
- **Only `apps/hub/` touches a provider** or an agent runtime, and only its
  platform files (`hub-*.ts`, `db.ts`, `schema.ts`, `migrate.ts`) import
  Interchange internals.
- **The client never writes persistence.** No database, schema or engine import
  in `apps/web/`.

## Honesty rules that are product requirements, not style

- A control that does not exist is **absent**, never simulated. The bounded build
  bridge reports final text and an exit status; it does not synthesise events,
  sessions, steering or checkpoints from stdout.
- An unknown is not a pass. A process exiting zero is not evidence.
- Secrets never reach a response body, a log, an artifact or a prompt. The UI
  sees a status and a boolean.
- No cloud fallback when a local endpoint is unavailable. Unavailable is a state.
- An approval names exact versions and their hashes.

## Conventions

- Plain-English commit messages, no conventional-commit prefixes.
- One issue per defect, one PR per issue.
- Comments explain why, not what. The code says what.
