// Pure scheduler: debounces workspace.selected and suppresses the
// created->selected auto-select yank, without touching real timers.
// The caller feeds it timestamped events and polls it with a clock value
// (real Date.now() when live, or the event stream's own occurredAtMs when
// replaying history) to find out what to actuate and when.

import type { CmuxWorkspaceEvent } from "./parser.ts";

export type GateEmission =
  | { kind: "actuate"; event: CmuxWorkspaceEvent }
  | { kind: "dropped"; event: CmuxWorkspaceEvent; reason: "created-suppression" };

export class Gate {
  private recentCreatedAt = new Map<string, number>(); // workspaceId -> last created occurredAtMs
  private pending: { event: CmuxWorkspaceEvent; readyAt: number } | null = null;

  constructor(private debounceMs: number, private suppressMs: number) {}

  /** Config hot-reload: applies to the next debounced selected, not
   * retroactively to one already pending (its readyAt was computed under
   * the old value). */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  /** Feed one parsed event. Returns emissions that happen immediately
   * (created/renamed/closed/colored pass through; a suppressed selected is
   * dropped). A non-suppressed selected never emits here -- it becomes
   * pending and is only returned later by poll(). */
  feed(event: CmuxWorkspaceEvent): GateEmission[] {
    if (event.name === "created") {
      this.recentCreatedAt.set(event.workspaceId, event.occurredAtMs);
      return [{ kind: "actuate", event }];
    }

    if (event.name === "selected") {
      const createdAt = this.recentCreatedAt.get(event.workspaceId);
      if (
        createdAt !== undefined &&
        event.occurredAtMs >= createdAt &&
        event.occurredAtMs - createdAt <= this.suppressMs
      ) {
        return [{ kind: "dropped", event, reason: "created-suppression" }];
      }
      // Debounce: this selected supersedes whatever was pending, regardless
      // of which workspace it targeted -- only the latest selection matters.
      this.pending = { event, readyAt: event.occurredAtMs + this.debounceMs };
      return [];
    }

    // renamed, closed, colored: pass through immediately, no debounce/suppression.
    return [{ kind: "actuate", event }];
  }

  /** Call with the current clock value to flush a pending debounced
   * selected once its readyAt has been reached. Returns null if nothing is
   * due yet. Consumes the pending entry on fire. */
  poll(now: number): GateEmission | null {
    if (this.pending && now >= this.pending.readyAt) {
      const event = this.pending.event;
      this.pending = null;
      return { kind: "actuate", event };
    }
    return null;
  }

  /** The clock value at which the next poll() would fire, or null if
   * nothing is pending. The caller uses this to schedule a real timer. */
  nextDeadline(): number | null {
    return this.pending ? this.pending.readyAt : null;
  }
}
