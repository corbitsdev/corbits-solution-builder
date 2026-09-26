/**
 * One `EventSource` per URL per tab, shared by every subscriber and released
 * while the tab is hidden (#91).
 *
 * Every stream this interface opens goes to the same origin over HTTP/1.1,
 * where Chrome allows six connections per host in total. A workspace tab
 * used to open its own stream per subscriber -- the dev reload, the app-wide
 * inbox, and a tenant mailbox stream each for the stage thread, every
 * advisory agent and stage 6's watcher -- so two tabs held more than six
 * and every ordinary fetch, in every tab, queued behind them for good. The
 * design pane's blank "Loading the design preview" was this.
 *
 * Here a subscriber gets a facade with the `EventSourceLike` surface it
 * already used (`addEventListener`/`close`); facades on the same URL share
 * one real source, opened on the first and closed after the last. A hidden
 * tab closes its real sources and reopens them when it is looked at again,
 * announcing `open` to every facade so a subscriber can treat it as a
 * reconnect; the tab a person is looking at is then the only one holding
 * connections.
 */
export type SharedEventSourceLike = {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};

type Listener = (event: { data: string }) => void;

/** The real thing, injectable for tests. */
export type RawEventSource = {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};
export type SharedEventSourceDeps = {
  createRaw: (url: string, withCredentials: boolean) => RawEventSource;
  /** Whether the tab is visible right now. */
  visible: () => boolean;
};

type Facade = { listeners: Map<string, Set<Listener>>; closed: boolean };
type Entry = {
  url: string;
  withCredentials: boolean;
  raw: RawEventSource | null;
  facades: Set<Facade>;
  /** Event types wired on `raw` so far; a new type is added to the live source as it appears. */
  wired: Set<string>;
};

const defaultDeps: SharedEventSourceDeps = {
  createRaw: (url, withCredentials) => new EventSource(url, { withCredentials }),
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
};

export function createSharedEventSources(deps: SharedEventSourceDeps = defaultDeps) {
  const entries = new Map<string, Entry>();

  const dispatch = (entry: Entry, type: string, event: { data: string }) => {
    for (const facade of [...entry.facades]) {
      if (facade.closed) continue;
      for (const listener of facade.listeners.get(type) ?? []) listener(event);
    }
  };

  const wire = (entry: Entry, type: string) => {
    if (!entry.raw || entry.wired.has(type)) return;
    entry.wired.add(type);
    entry.raw.addEventListener(type, (event) => dispatch(entry, type, event));
  };

  const open = (entry: Entry) => {
    if (entry.raw || entry.facades.size === 0 || !deps.visible()) return;
    entry.raw = deps.createRaw(entry.url, entry.withCredentials);
    entry.wired = new Set();
    const types = new Set<string>(["open", "error", "message"]);
    for (const facade of entry.facades) for (const type of facade.listeners.keys()) types.add(type);
    for (const type of types) wire(entry, type);
  };

  const release = (entry: Entry) => {
    entry.raw?.close();
    entry.raw = null;
    entry.wired = new Set();
  };

  return {
    /** A subscriber's own handle on the shared stream for `url`. */
    open(url: string, withCredentials: boolean): SharedEventSourceLike {
      let entry = entries.get(url);
      if (!entry) {
        entry = { url, withCredentials, raw: null, facades: new Set(), wired: new Set() };
        entries.set(url, entry);
      }
      const facade: Facade = { listeners: new Map(), closed: false };
      entry.facades.add(facade);
      const owner = entry;
      open(owner);
      return {
        addEventListener(type, listener) {
          if (facade.closed) return;
          let set = facade.listeners.get(type);
          if (!set) {
            set = new Set();
            facade.listeners.set(type, set);
          }
          set.add(listener);
          wire(owner, type);
        },
        close() {
          if (facade.closed) return;
          facade.closed = true;
          owner.facades.delete(facade);
          if (owner.facades.size === 0) {
            release(owner);
            entries.delete(owner.url);
          }
        },
      };
    },
    /** The tab was hidden: let go of every connection, keeping the subscribers. */
    hidden() {
      for (const entry of entries.values()) release(entry);
    },
    /** The tab is looked at again: reopen for everyone still subscribed and say so. */
    visible() {
      for (const entry of entries.values()) {
        if (entry.raw || entry.facades.size === 0) continue;
        open(entry);
        if (entry.raw) dispatch(entry, "open", { data: "" });
      }
    },
    /** How many real connections are open right now. */
    connections(): number {
      return [...entries.values()].filter((entry) => entry.raw !== null).length;
    },
  };
}

const shared = createSharedEventSources();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") shared.hidden();
    else shared.visible();
  });
}

/** The tab's shared stream for `url` -- what every opener in this interface uses. */
export function openSharedEventSource(url: string, withCredentials: boolean): SharedEventSourceLike {
  return shared.open(url, withCredentials);
}
