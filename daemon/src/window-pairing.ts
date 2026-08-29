// Stateful layer over the pure join: turns snapshots into a usable answer for
// "which Chrome window belongs to this cmux window?".
//
// The awkward part this exists to solve: the join speaks CGWindowIDs, metamux
// speaks cmux's own window UUIDs, and nothing maps the two. The bridge is the
// DISPLAY. Activating a workspace puts its cmux window on screen, so an
// activation binds that cmux window UUID to whichever display currently holds
// the on-screen cmux window. Compose that with the join's display -> Chrome
// window and the question is answerable.
//
// The rule for windows that are not currently visible:
//
//     derive when visible, remember when not, re-verify on return.
//
// Bindings survive going off-Space and are refreshed the moment that Space comes
// back, so a Chrome window replaced while you were away is picked up rather than
// remembered wrongly.

import { joinWindows, TERMINAL_OWNERS, type CGWindow, type ChromeWindow, type Display, type Pair, type Violation } from "./window-join.ts";

export interface WindowPairingOptions {
  /** A snapshot older than this means the helper died or stalled. Treated as
   * unhealthy so callers fall back rather than acting on stale geometry. */
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 10_000;

export class WindowPairing {
  private chromeByDisplay = new Map<number, number>();
  private cmuxWindowToDisplay = new Map<string, number>();
  private onScreenCmuxDisplay: number | null = null;
  private terminalDisplays = new Set<number>();
  private lostTerminalDisplays: number[] = [];
  private displayBoundsById = new Map<number, Display["bounds"]>();
  private lastPairs: Pair[] = [];
  private lastViolations: Violation[] = [];
  private lastIngestAt: number | null = null;
  private readonly staleAfterMs: number;

  constructor(options: WindowPairingOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  ingest(cgWindows: CGWindow[], chromeWindows: ChromeWindow[], displays: Display[], now = Date.now()): void {
    const { pairs, violations } = joinWindows(cgWindows, chromeWindows, displays);
    for (const d of displays) this.displayBoundsById.set(d.id, d.bounds);
    this.lastViolations = violations;
    this.lastPairs = pairs;
    this.lastIngestAt = now;

    // Refresh only the displays actually visible right now. Untouched entries
    // are the remembered off-Space bindings and must survive.
    // A display that had a terminal and now does not. Derived from snapshots
    // because the event log carries no usable window-close signal. Skipped when
    // the whole snapshot went empty: that is a Space switch, not a close, and
    // parking on it would hide the browser every time the desktop changes.
    const terminalsNow = new Set<number>();
    for (const p of pairs) terminalsNow.add(p.displayId);
    for (const v of violations) {
      if (v.kind === "unpaired" && TERMINAL_OWNERS.includes(v.owner)) terminalsNow.add(v.displayId);
    }
    const snapshotWentEmpty = cgWindows.length === 0;
    this.lostTerminalDisplays = snapshotWentEmpty
      ? []
      : [...this.terminalDisplays].filter((d) => !terminalsNow.has(d));
    this.terminalDisplays = terminalsNow;

    this.onScreenCmuxDisplay = pairs.length === 1 ? pairs[0].displayId : null;
    for (const p of pairs) {
      if (p.chromeWindowId !== null) this.chromeByDisplay.set(p.displayId, p.chromeWindowId);
    }
  }

  /** A workspace was activated in cmux window `cmuxWindowId`. Bind it to the
   * display holding the on-screen cmux window. Skipped while the invariant is
   * violated: a binding learned from an ambiguous frame is worse than none. */
  noteActivation(cmuxWindowId: string, now = Date.now()): void {
    if (!this.healthyAt(now)) return;
    if (this.onScreenCmuxDisplay === null) return;
    this.cmuxWindowToDisplay.set(cmuxWindowId, this.onScreenCmuxDisplay);
  }

  chromeWindowFor(cmuxWindowId: string, now = Date.now()): number | null {
    if (!this.healthyAt(now)) return null;
    const display = this.cmuxWindowToDisplay.get(cmuxWindowId);
    if (display === undefined) return null;
    return this.chromeByDisplay.get(display) ?? null;
  }

  /** Exposed for diagnostics and for callers that want to know a binding was
   * learned even while the current frame is unusable. */
  rememberedDisplayFor(cmuxWindowId: string): number | null {
    return this.cmuxWindowToDisplay.get(cmuxWindowId) ?? null;
  }

  /** Displays holding a terminal window with no browser partner. Empty while
   * unhealthy: auto-create must never fire off an ambiguous frame. */
  displaysNeedingPartner(now = Date.now()): number[] {
    if (!this.healthyAt(now)) return [];
    return this.lastViolations
      .filter((v) => v.kind === "unpaired" && TERMINAL_OWNERS.includes(v.owner))
      .map((v) => v.displayId);
  }

  /** The pairs resolved from the most recent snapshot, for diagnostics. */
  currentPairs(): Pair[] {
    return this.lastPairs;
  }

  /** Where to place a partner window for a display. */
  displayBounds(displayId: number): Display["bounds"] | null {
    return this.displayBoundsById.get(displayId) ?? null;
  }

  /** The Chrome window paired to a display, regardless of which cmux window
   * pointed at it. Park needs this after the terminal has already gone. */
  chromeWindowForDisplay(displayId: number): number | null {
    return this.chromeByDisplay.get(displayId) ?? null;
  }

  /** Displays whose terminal window went away since the previous snapshot. */
  displaysThatLostTerminal(): number[] {
    return this.lostTerminalDisplays;
  }

  get violations(): Violation[] {
    return this.lastViolations;
  }

  get healthy(): boolean {
    return this.healthyAt(Date.now());
  }

  /** Unhealthy means "fall back to the marker tab", never "guess". Either the
   * one-per-Space invariant broke, or the helper stopped reporting. */
  healthyAt(now: number): boolean {
    if (this.lastIngestAt === null) return false;
    if (now - this.lastIngestAt > this.staleAfterMs) return false;
    return this.lastViolations.every((v) => v.kind !== "ambiguous");
  }
}
