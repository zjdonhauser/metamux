// Pure lazy-inclusion filter for createGroups: "lazy". Independent of
// group-projection.ts's title-aliasing -- this operates on whatever
// identity ids it's given (real workspace ids in groupBy: "workspace",
// alias ids in groupBy: "title"), so the two compose freely.
//
// An identity is "attached" once it's been activated or open_url'd at
// least once. In-memory only (like Gate's pending-select and PortsTracker's
// dedupe state) -- resets each daemon restart, not persisted to disk.

import type { ActuatorEvent, ActuatorWorkspace } from "./registry.ts";

export class LazyGroupTracker {
  private attachedAt = new Map<string, string>();

  /** Marks an identity attached. Idempotent -- only the first call for a
   * given id records a timestamp; later calls are no-ops. */
  markAttached(id: string, atIso: string = new Date().toISOString()): void {
    if (!this.attachedAt.has(id)) this.attachedAt.set(id, atIso);
  }

  isAttached(id: string): boolean {
    return this.attachedAt.has(id);
  }

  attachedAtFor(id: string): string | null {
    return this.attachedAt.get(id) ?? null;
  }

  /** For the sync frame / GET /state: only identities that are currently
   * active or have ever been attached. */
  filterForSync(identities: ActuatorWorkspace[], activeId: string | null): ActuatorWorkspace[] {
    return identities.filter((i) => i.id === activeId || this.attachedAt.has(i.id));
  }

  /** For a broadcast batch: suppress `workspace.upserted` for an identity
   * that isn't active/attached (that's the event that would otherwise
   * make the extension create a group). `workspace.activated` and
   * `workspace.archived` always pass through -- activated always means
   * the identity IS now active, and an archive of something never
   * attached is a harmless no-op for the extension either way. */
  filterEvents(events: ActuatorEvent[], activeId: string | null): ActuatorEvent[] {
    return events.filter((e) => {
      if (e.name !== "workspace.upserted") return true;
      return e.workspace.id === activeId || this.attachedAt.has(e.workspace.id);
    });
  }
}
