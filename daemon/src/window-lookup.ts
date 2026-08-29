// Throttled, coalesced lookup of which cmux window currently holds a workspace.
//
// Answering this costs listWindows plus one listTabs per window, and
// workspace.selected fires often, so a naive call site would run N+1 CLI
// commands every time you switch tabs. This caches per workspace for a short
// window and collapses concurrent callers onto one in-flight request.
//
// A thrown lookup is NOT cached: cmux being momentarily unreachable is a
// transient failure, and caching it would suppress the retry. A null result IS
// cached, because "in no window" is a real answer.

export interface WindowLookupOptions {
  minIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 3_000;

interface Entry {
  window: string | null;
  at: number;
}

export class WindowLookup {
  private cache = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<string | null>>();
  private readonly minIntervalMs: number;

  constructor(
    private readonly lookup: (workspaceId: string) => Promise<string | null>,
    options: WindowLookupOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  async holdingWindow(workspaceId: string, now = Date.now()): Promise<string | null> {
    const cached = this.cache.get(workspaceId);
    if (cached && now - cached.at < this.minIntervalMs) return cached.window;

    const existing = this.inFlight.get(workspaceId);
    if (existing) return existing;

    const request = this.lookup(workspaceId)
      .then((window) => {
        this.cache.set(workspaceId, { window, at: now });
        return window;
      })
      .catch(() => null)
      .finally(() => {
        this.inFlight.delete(workspaceId);
      });

    this.inFlight.set(workspaceId, request);
    return request;
  }
}
