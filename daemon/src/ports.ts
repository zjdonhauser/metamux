// Pure dedupe/diff/guard logic for the ports watcher (F8). No polling, no
// RPC -- the caller feeds it a workspace id and its current listening_ports
// list on each poll; this module decides what's new, what's actionable,
// and what's over the per-cycle cap.
//
// Three guards, all here so they're unit-testable without a live daemon:
//  1. Baseline on first sight: the FIRST poll for a workspace establishes
//     its known ports as a baseline and emits nothing -- only ports that
//     appear on a LATER poll are candidates ("his dev server starts").
//  2. Ephemeral cutoff: ports > maxPort (default 49151, i.e. >= 49152) are
//     never auto-opened -- macOS ephemeral-range listeners (debuggers, MCP
//     servers, etc). Still visible via portsFor() for /state and the panel.
//  3. Per-cycle cap: at most `autoOpenCap` (default 2) auto-opens per poll
//     per workspace; the rest of that cycle's fresh ports are notifyOnly.

const DEFAULT_MAX_PORT = 49151;
const DEFAULT_AUTO_OPEN_CAP = 2;

export interface PortsDiffOptions {
  ignore?: number[];
  /** Ports > maxPort are never auto-opened (still shown via portsFor). */
  maxPort?: number;
  /** Max fresh ports returned in autoOpen per call; the rest land in notifyOnly. */
  autoOpenCap?: number;
}

export interface PortsDiffResult {
  autoOpen: number[];
  notifyOnly: number[];
}

export class PortsTracker {
  private seen = new Set<string>(); // `${workspaceId}:${port}`
  private baselined = new Set<string>(); // workspaceIds that have had a first poll
  private currentByWorkspace = new Map<string, number[]>();

  /** Feed one poll result for a workspace. Returns the fresh, non-ignored,
   * non-ephemeral ports split into autoOpen (up to the cap) and
   * notifyOnly (the cap overflow) -- both empty on a workspace's first
   * poll (baseline) or when nothing new appeared. Also updates
   * portsFor()'s view of this workspace's current (non-ignored) ports,
   * ephemeral included, whether or not anything was fresh. */
  diff(workspaceId: string, ports: number[], options: PortsDiffOptions = {}): PortsDiffResult {
    const ignoreSet = new Set(options.ignore ?? []);
    const maxPort = options.maxPort ?? DEFAULT_MAX_PORT;
    const autoOpenCap = options.autoOpenCap ?? DEFAULT_AUTO_OPEN_CAP;
    const isBaselinePoll = !this.baselined.has(workspaceId);

    const current: number[] = [];
    const fresh: number[] = [];

    for (const port of ports) {
      if (ignoreSet.has(port)) continue;
      current.push(port);

      const key = `${workspaceId}:${port}`;
      const alreadySeen = this.seen.has(key);
      if (!alreadySeen) this.seen.add(key);

      if (isBaselinePoll || alreadySeen) continue; // baseline, or not new
      if (port > maxPort) continue; // ephemeral -- shown, never actioned

      fresh.push(port);
    }

    this.baselined.add(workspaceId);
    this.currentByWorkspace.set(workspaceId, current);

    return {
      autoOpen: fresh.slice(0, autoOpenCap),
      notifyOnly: fresh.slice(autoOpenCap),
    };
  }

  /** The most recently polled (non-ignored) ports for a workspace, for
   * GET /state and sync-frame exposure -- includes ephemeral ports.
   * Empty for a workspace never polled. */
  portsFor(workspaceId: string): number[] {
    return this.currentByWorkspace.get(workspaceId) ?? [];
  }
}
