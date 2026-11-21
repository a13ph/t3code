/**
 * Keeps a resolved link chip live: while the page is visible, the link is asked for again every
 * `RESOLVED_LINK_REFRESH_MS`, and once more when the window gains focus.
 *
 * Chips are grouped by server and link, the same key as the query atom they read, so any number
 * of chips for one link on one server share one timer and one request per tick.
 */

// Cost: one RPC, and one line to the server's resolver, per visible link per 15 s.
const RESOLVED_LINK_REFRESH_MS = 15_000;
// A focus right after a tick, or a burst of focus events, asks once.
const MIN_GAP_MS = 1_000;

interface Group {
  readonly refreshers: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  lastAt: number;
}

const groups = new Map<string, Group>();
let focusListening = false;

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function tick(group: Group, now: number): void {
  if (!isVisible() || now - group.lastAt < MIN_GAP_MS) return;
  const refresh = group.refreshers.values().next().value;
  if (refresh === undefined) return;
  group.lastAt = now;
  refresh();
}

function onFocus(): void {
  const now = Date.now();
  for (const group of groups.values()) tick(group, now);
}

function syncFocusListener(): void {
  if (typeof window === "undefined") return;
  const want = groups.size > 0;
  if (want === focusListening) return;
  focusListening = want;
  if (want) window.addEventListener("focus", onFocus);
  else window.removeEventListener("focus", onFocus);
}

/** Registers a mounted chip's refresh for `key`; the returned function unregisters it. */
export function subscribeResolvedLinkRefresh(key: string, refresh: () => void): () => void {
  let group = groups.get(key);
  if (group === undefined) {
    const created: Group = { refreshers: new Set(), timer: null, lastAt: Date.now() };
    created.timer = setInterval(() => tick(created, Date.now()), RESOLVED_LINK_REFRESH_MS);
    groups.set(key, created);
    group = created;
  }
  group.refreshers.add(refresh);
  syncFocusListener();
  const joined = group;
  return () => {
    joined.refreshers.delete(refresh);
    if (joined.refreshers.size > 0 || groups.get(key) !== joined) return;
    if (joined.timer !== null) clearInterval(joined.timer);
    groups.delete(key);
    syncFocusListener();
  };
}
