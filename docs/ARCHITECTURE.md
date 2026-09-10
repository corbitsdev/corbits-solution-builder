# Architecture

A native desktop shell over a persistent local host. The host is the product;
the window and the tray are clients. The host embeds the Interchange control
plane and runs the nine-stage lifecycle through Interchange's own workflow
runtime, in one process, on an embedded database.

## Components

```
apps/hub/                    the host: loopback API, guard, engine, persistence, the embedded Interchange hub
apps/web/                    the client
apps/desktop/                the native shell and tray
packages/solutions-builder/  the app package: the transition ledger, the workflows generated from it,
                             the specialist kit, the document format
```

**The app package** (`packages/solutions-builder`) is the product itself,
stated once: the ledger with every state, command, authority and transition
and the three forbidden cases; the Interchange workflow definitions generated
from it; the specialist kit and its prompts; and the document format the
client and the hub both parse. It depends on nothing in the apps and on no
platform internals. It is what will become the package installed into an
Interchange tenant. The hub boots vanilla (migrate, mount, serve) and the
client installs the package into the tenant on first launch and after every
credential change; what the hub still holds beside Interchange's tables is
the part of the tree that shrinks as it becomes vanilla.

**The hub** (`apps/hub`) owns the loopback API, the database, the guard that
enforces the ledger, the engine that applies commands, the providers and the
agent runs, and the mounted Interchange hub. Only its platform files
(`hub-*.ts`, `db.ts`, `schema.ts`, `migrate.ts`) import Interchange
internals. It is the only place a run's state is written and the only area
allowed to reach a provider.

**The client** (`apps/web`) renders and asks. It imports the app package for
names and the document format, and never the hub.

**The desktop shell** (`apps/desktop`) starts the hub, opens the window on the
URL it prints, keeps a tray presence, and leaves the hub running when the
window closes.

