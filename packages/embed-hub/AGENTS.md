# @corbits/embed-hub

Hub embedding composition. The rules that keep it reusable:

- **Composition only.** Wire platform pieces together; no product routes, no
  product strings (`callbackPageCopy`, `notificationSender` arrive through
  options), nothing from `apps/` or a product package.
- **Platform internals are the point.** This package may import `@intx/*`
  internals; `MountedHub` re-exposes some of them (`db`, `auth`,
  `assetService`), which is why consumers treat the package itself as
  platform surface.
- **`pg-compat` stays a leaf.** It exists for callers barred from platform
  internals — adding an `@intx/*` import to it breaks that contract.
- **Secrets stay abstract.** Key material arrives as hex/options; the package
  never reaches into a keychain or the filesystem for credentials.
