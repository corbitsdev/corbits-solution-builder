# @corbits/embedded-host

Generic host runtime. The rules that keep it reusable:

- **No product strings.** Naming, env vars, cookies, accounts, copy — all
  arrive through `HostIdentity`/`initHost`. A literal product name in `src/`
  is a bug.
- **No product APIs.** Routes come in through `serveHost({ api })`. Nothing
  here may import from `apps/` or a product package.
- **`initHost` first.** Every module may assume it ran; touching identity or
  the keychain before it throws. Keep the failure loud.
- **Platform internals are the point.** This package may import `@intx/*`
  internals; it is one of the two places in the tree allowed to (the other
  is `@corbits/embed-hub`). Consumers must not be able to reach `MountedHub`
  internals without going through this package's surface deliberately.
