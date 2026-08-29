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

import { joinWindows, type CGWindow, type ChromeWindow, type Display, type Violation } from "./window-join.ts";

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
  private lastViolations: Violation[] = [];
  private lastIngestAt: number | null = null;
  private readonly staleAfterMs: number;

  constructor(options: WindowPairingOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  ingest(cgWindows: CGWindow[], chromeWindows: ChromeWindow[], displays: Display[], now = Date.now()): void {
    const { pairs, violations } = joinWindows(cgWindows, chromeWindows, displays);
    this.lastViolations = violations;
    this.lastIngestAt = now;

    // Refresh only the displays actually visible right now. Untouched entries
    // are the remembered off-Space bindings and must survive.
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
