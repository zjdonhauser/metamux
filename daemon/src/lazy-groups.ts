// Pure lazy-inclusion filter for createGroups: "on-open" | "on-activate".
// Independent of group-projection.ts's title-aliasing -- this operates on
// whatever identity ids it's given (real workspace ids in groupBy:
// "workspace", alias ids in groupBy: "title"), so the two compose freely.
//
// An identity is "attached" once markAttached is called for it -- always
// via open_url; also via activation/window follow in "on-activate" mode
// (registry.ts's attachOnActivate / server.ts's broadcast()). In-memory
// only (like Gate's pending-select and PortsTracker's dedupe state) --
// resets each daemon restart, not persisted to disk (WorkspaceRef.attachedAt
// is the persisted counterpart; seedFromRefs below re-derives this from it).

import type { ActuatorEvent, ActuatorWorkspace, WorkspaceRef } from "./registry.ts";

export class LazyGroupTracker {
  private attachedAt = new Map<string, string>();

  /** Marks an identity attached. Idempotent -- only the first call for a
   * given id records a timestamp; later calls are no-ops. */
  markAttached(id: string, atIso: string = new Date().toISOString()): void {
    if (!this.attachedAt.has(id)) this.attachedAt.set(id, atIso);
  }

  /** Seeds attachment from persisted WorkspaceRef.attachedAt timestamps at
   * daemon startup, so createGroups doesn't re-hide a group the
   * user already had open just because the daemon restarted (registry.json
   * survives the restart; this in-memory tracker otherwise wouldn't).
   * `identityFor` maps each ref to its wire identity (itself in groupBy:
   * "workspace", its alias in groupBy: "title") -- alias-level attachment
   * ("any member attached") falls out for free since markAttached is
   * idempotent and multiple members seeding the same alias id is a no-op
   * after the first. Refs with attachedAt: null are skipped. */
  seedFromRefs(refs: WorkspaceRef[], identityFor: (ref: WorkspaceRef) => string): void {
    for (const ref of refs) {
      if (ref.attachedAt !== null) this.markAttached(identityFor(ref), ref.attachedAt);
    }
  }

  isAttached(id: string): boolean {
    return this.attachedAt.has(id);
  }

  attachedAtFor(id: string): string | null {
    return this.attachedAt.get(id) ?? null;
  }

  /** Detach-on-close (userClosedGroup) counterpart to markAttached: removes
   * the in-memory attachment record so filterForSync/filterEvents stop
   * including this identity until it's reopened. No-op if already
   * unattached. */
  clearAttached(id: string): void {
    this.attachedAt.delete(id);
  }

  /** For the sync frame / GET /state: only identities that have ever been
   * attached. No "or currently active" shortcut -- createGroups: "on-open"
   * requires that a group is only ever created carrying a real tab, and an
   * identity can be active without ever having been opened. This is a
   * no-op change for "on-activate" mode: activation attaches synchronously
   * there (registry.ts/server.ts), so by the time this runs the identity
   * is already genuinely attached. */
  filterForSync(identities: ActuatorWorkspace[]): ActuatorWorkspace[] {
    return identities.filter((i) => this.attachedAt.has(i.id));
  }

  /** For a broadcast batch: suppress `workspace.upserted` for an identity
   * that isn't attached (that's the event that would otherwise make the
   * extension create a group). `workspace.activated` and
   * `workspace.archived` always pass through -- an archive of something
   * never attached is a harmless no-op for the extension either way, and
   * activation alone never creates a group (chrome-ops's activate() is a
   * no-op on a groupless entry) -- see docs/protocol.md, createGroups. No
   * "or currently active" shortcut, for the same reason as filterForSync. */
  filterEvents(events: ActuatorEvent[]): ActuatorEvent[] {
    return events.filter((e) => {
      if (e.name !== "workspace.upserted") return true;
      return this.attachedAt.has(e.workspace.id);
    });
  }
}
