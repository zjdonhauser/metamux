// Pure workspace registry: upsert/re-bind rules and the derivation of
// actuator events from cmux workspace events. No I/O -- persistence is the
// caller's job (main.ts writes registry.json via paths.ts); the named-slot
// color table (from ~/.config/cmux/cmux.json) is read once by main.ts and
// injected at construction.

import { randomBytes } from "node:crypto";
import { nearestChromeGroupColor, resolveCmuxColor, TAB_GROUP_COLORS, type ChromeGroupColor } from "./colors.ts";
import type { CmuxWorkspaceEvent } from "./parser.ts";
import type { RegistryIntent } from "./tmux-reconcile.ts";

export { TAB_GROUP_COLORS };

/** "cmux": a cmux workspace tab, sourceId = its cmux workspace UUID.
 * "tmux": a tmux session (docs/tmux-port-plan.md §2.1), sourceId = its
 * tmux #{session_id} ("$N" form, stable across a rename) -- NOT the
 * session name, which is the mutable title. */
export type WorkspaceSource = "cmux" | "tmux";

export interface WorkspaceRef {
  id: string; // "mw_" + 8 random hex; stable forever
  title: string;
  cwd: string | null;
  source: WorkspaceSource;
  sourceId: string;
  archived: boolean;
  /** Resolved cmux color as a final "#RRGGBB" hex, or null if never set
   * (or cleared). Named cmux.json slots are resolved to hex before
   * landing here -- see colors.ts's resolveCmuxColor. */
  cmuxColor: string | null;
  /** ISO timestamp of first attachment (always open_url; also activation
   * in createGroups: "on-activate"), or null if never attached / cleared
   * by a user close (userClosedGroup). Persisted (survives a daemon
   * restart) so createGroups doesn't re-hide a group the user already had
   * open -- see LazyGroupTracker.seedFromRefs in lazy-groups.ts. */
  attachedAt: string | null;
  /** Color backflow (daemon/src/color-backflow.ts): the hex WE last
   * painted onto this ref's cmux tab via `cmux workspace-action
   * set-color`, or null if backflow has never painted it. This is what
   * lets backflow tell "the user set this color" (cmuxColor !==
   * paintedColor) apart from "this is just our own paint echoing back
   * through the colored event" (cmuxColor === paintedColor) --
   * markPainted is the only writer. Persisted: without it, a restart
   * would forget what backflow owns and misclassify every previously-
   * painted tab as user-owned. cmux-sourced refs only in practice (a
   * tmux-sourced ref has no cmux tab of its own to paint), but not
   * type-restricted to "cmux" since a ref can be reclassified between
   * sources (tmux-migration.ts). */
  paintedColor: string | null;
  updatedAt: string; // ISO
}

export interface ActuatorWorkspace {
  id: string;
  title: string;
  color: string;
  archived: boolean;
}

export type ActuatorEvent =
  | { name: "workspace.upserted"; workspace: ActuatorWorkspace }
  | { name: "workspace.activated"; workspace: ActuatorWorkspace }
  | { name: "workspace.archived"; workspace: ActuatorWorkspace };

/** The workspace's mapped cmuxColor when set and resolvable, else a
 * deterministic hash of the title: sum of UTF-16 char codes mod 9. */
export function colorFor(title: string, cmuxColor?: string | null): ChromeGroupColor {
  if (cmuxColor) {
    const mapped = nearestChromeGroupColor(cmuxColor);
    if (mapped) return mapped;
  }
  let sum = 0;
  for (let i = 0; i < title.length; i++) {
    sum += title.charCodeAt(i);
  }
  return TAB_GROUP_COLORS[sum % TAB_GROUP_COLORS.length]!;
}

function toActuator(ref: WorkspaceRef): ActuatorWorkspace {
  return { id: ref.id, title: ref.title, color: colorFor(ref.title, ref.cmuxColor), archived: ref.archived };
}

function newId(): string {
  return "mw_" + randomBytes(4).toString("hex");
}

export class Registry {
  workspaces: Map<string, WorkspaceRef> = new Map();
  activeId: string | null = null;
  /** createGroups: "on-activate" (legacy "lazy") vs "on-open": whether
   * activation (selected, window follow) attaches, in addition to
   * open_url which always attaches regardless. Default true (the more
   * conservative, historical behavior) for any caller that doesn't set it
   * explicitly. Mutable (not constructor-only) because createGroups is
   * hot-reloadable -- main.ts sets this immediately after construction,
   * before the seed replay, and again on a live config change. */
  attachOnActivate = true;

  constructor(private namedSlots: Record<string, string> | null = null) {}

  private findBySourceId(source: WorkspaceSource, sourceId: string): WorkspaceRef | null {
    for (const ref of this.workspaces.values()) {
      if (ref.source === source && ref.sourceId === sourceId) return ref;
    }
    return null;
  }

  /** Re-bind rule: match by (source, sourceId); else by (title, cwd)
   * AMONG REFS OF THE SAME SOURCE, archived+live; else no match (caller
   * creates new). The same-source scoping on the title/cwd fallback is
   * required, not cosmetic: once a tmux session and an unrelated cmux tab
   * can legitimately share a title, matching across sources would wrongly
   * re-bind them to the same ref (docs/tmux-port-plan.md §2.1's Phase 0
   * requirement). */
  private findMatch(source: WorkspaceSource, sourceId: string, title: string, cwd: string | null): WorkspaceRef | null {
    const bySourceId = this.findBySourceId(source, sourceId);
    if (bySourceId) return bySourceId;
    for (const ref of this.workspaces.values()) {
      if (ref.source === source && ref.title === title && ref.cwd === cwd) return ref;
    }
    return null;
  }

  private upsert(
    source: WorkspaceSource,
    sourceId: string,
    title: string,
    cwd: string | null,
  ): { ref: WorkspaceRef; changed: boolean } {
    const existing = this.findMatch(source, sourceId, title, cwd);
    if (existing) {
      const changed =
        existing.title !== title ||
        existing.cwd !== cwd ||
        existing.sourceId !== sourceId ||
        existing.archived; // unarchiving counts as a change worth an upsert event
      existing.title = title;
      existing.cwd = cwd;
      existing.sourceId = sourceId;
      existing.archived = false;
      existing.updatedAt = new Date().toISOString();
      return { ref: existing, changed };
    }
    const ref: WorkspaceRef = {
      id: newId(),
      title,
      cwd,
      source,
      sourceId,
      archived: false,
      cmuxColor: null,
      attachedAt: null,
      paintedColor: null,
      updatedAt: new Date().toISOString(),
    };
    this.workspaces.set(ref.id, ref);
    return { ref, changed: true };
  }

  /** Resolves and applies a raw cmux color (hex, named slot, or null) to
   * the workspace matching `sourceId`. Shared by applyEvent's `colored`
   * branch and main.ts's post-seed color backfill (from `cmux rpc
   * workspace.current` / `workspace list`, for colors set before the
   * daemon started tailing). No-op if the workspace is unknown or the
   * resolved color is unchanged. */
  applyColor(sourceId: string, rawColor: string | null): ActuatorEvent[] {
    const existing = this.findBySourceId("cmux", sourceId); // only cmux ever emits set_color/clear_color
    if (!existing) return [];
    const resolved = resolveCmuxColor(rawColor, this.namedSlots);
    if (existing.cmuxColor === resolved) return [];
    existing.cmuxColor = resolved;
    existing.updatedAt = new Date().toISOString();
    return [{ name: "workspace.upserted", workspace: toActuator(existing) }];
  }

  /** Marks a workspace attached (idempotent -- the first call for a given
   * id records the timestamp; later calls are no-ops). Called on
   * activation (selected, window follow) when attachOnActivate is true,
   * and always when open_url targets a workspace directly (server.ts).
   * No-op for an unknown id. */
  markAttached(id: string, atIso: string = new Date().toISOString()): void {
    const ref = this.workspaces.get(id);
    if (ref && ref.attachedAt === null) ref.attachedAt = atIso;
  }

  /** Detach-on-close (userClosedGroup): clears a workspace's attachedAt so
   * createGroups' lazy filter stops including it until it's reopened.
   * No-op for an unknown id or one already unattached. */
  clearAttached(id: string): void {
    const ref = this.workspaces.get(id);
    if (ref) ref.attachedAt = null;
  }

  /** Color backflow's only writer of `paintedColor` (color-backflow.ts is
   * pure and never touches the registry itself). Called right after the
   * cmux actuator's set-color call succeeds -- optimistic, not waiting for
   * the `colored` event to round-trip through the tail, so the very next
   * backflow tick already sees this ref as ours rather than momentarily
   * misreading it as user-owned. Does NOT touch `cmuxColor` (that's
   * applyColor's job, driven by the tailed event, whether it's reporting
   * our own echo or a user override) or derive any ActuatorEvent -- a
   * cmux tab's own color has no effect on what's broadcast over the wire
   * protocol, only on what the user sees in cmux itself. No-op for an
   * unknown id. */
  markPainted(id: string, hex: string): void {
    const ref = this.workspaces.get(id);
    if (ref) ref.paintedColor = hex;
  }

  /** Apply one parsed cmux workspace event to the registry, returning the
   * actuator events it derives (may be empty). */
  applyEvent(event: CmuxWorkspaceEvent): ActuatorEvent[] {
    if (event.name === "closed") {
      const existing = this.findMatch("cmux", event.workspaceId, event.title, event.cwd);
      if (!existing) return [];
      existing.archived = true;
      existing.updatedAt = new Date().toISOString();
      return [{ name: "workspace.archived", workspace: toActuator(existing) }];
    }

    if (event.name === "colored") {
      return this.applyColor(event.workspaceId, event.color ?? null);
    }

    // created, renamed, selected all upsert first.
    const { ref, changed } = this.upsert("cmux", event.workspaceId, event.title, event.cwd);
    const out: ActuatorEvent[] = [];
    if (changed) out.push({ name: "workspace.upserted", workspace: toActuator(ref) });

    if (event.name === "selected") {
      this.activeId = ref.id;
      if (this.attachOnActivate) this.markAttached(ref.id);
      out.push({ name: "workspace.activated", workspace: toActuator(ref) });
    }

    return out;
  }

  /** F7 window follow: activate a known workspace by its cmux sourceId
   * without touching title/cwd (a window-focus signal carries no rename
   * info, unlike a real workspace.selected event). No-op if the sourceId
   * is unknown or already active. */
  activateBySourceId(sourceId: string): ActuatorEvent[] {
    const target = this.findBySourceId("cmux", sourceId); // window focus is a cmux-window concept
    if (!target || this.activeId === target.id) return [];
    this.activeId = target.id;
    if (this.attachOnActivate) this.markAttached(target.id);
    return [{ name: "workspace.activated", workspace: toActuator(target) }];
  }

  /** Applies one tmux-source RegistryIntent (tmux-reconcile.ts's pure
   * output -- docs/tmux-port-plan.md §2.1/§2.6) to the registry, mirroring
   * applyEvent's upsert/archive shape for source: "tmux" refs. Emitted for
   * every live session tmux-reconcile.ts touches each tick, idempotent by
   * construction (same "changed" check as upsert's cmux path), so the
   * caller doesn't need to figure out whether anything actually changed. */
  applyTmuxIntent(intent: RegistryIntent): ActuatorEvent[] {
    if (intent.type === "archiveTmuxRef") {
      const existing = this.findBySourceId("tmux", intent.sessionId);
      if (!existing || existing.archived) return [];
      existing.archived = true;
      existing.updatedAt = new Date().toISOString();
      return [{ name: "workspace.archived", workspace: toActuator(existing) }];
    }
    const { ref, changed } = this.upsert("tmux", intent.sessionId, intent.sessionName, null);
    return changed ? [{ name: "workspace.upserted", workspace: toActuator(ref) }] : [];
  }

  /** One-time migration only (docs/tmux-port-plan.md §3.1(b)/§5 Phase 5):
   * converts an existing cmux-sourced ref (tmux-cmux-sync's own tab,
   * matched by its cmux workspace UUID) into the tmux-sourced ref of
   * record for a session, preserving the ref's `id` -- and therefore its
   * paired Chrome group -- rather than creating a new one. No-op if no
   * cmux ref with that sourceId exists (already migrated, or never
   * existed). Idempotent: a second call for the same cmuxSourceId finds
   * nothing (the ref's source is now "tmux"), so re-running the migration
   * on every daemon restart is safe without a separate "already ran"
   * marker. */
  reclassifyAsTmux(cmuxSourceId: string, sessionId: string, sessionName: string): ActuatorEvent[] {
    const existing = this.findBySourceId("cmux", cmuxSourceId);
    if (!existing) return [];
    existing.source = "tmux";
    existing.sourceId = sessionId;
    existing.title = sessionName;
    existing.cwd = null;
    existing.updatedAt = new Date().toISOString();
    return [{ name: "workspace.upserted", workspace: toActuator(existing) }];
  }

  /** Migration-only sibling of reclassifyAsTmux: for every OTHER cmux ref
   * that mirrored the same tmux session in a different window (windows
   * mode creates one per window), the ref itself is no longer an
   * independent registry identity post-migration -- the cmux tab is
   * untouched, it becomes an actuator-tracked attachment instead of a
   * registry member -- so it's archived here rather than reclassified. */
  archiveBySourceId(source: WorkspaceSource, sourceId: string): ActuatorEvent[] {
    const existing = this.findBySourceId(source, sourceId);
    if (!existing || existing.archived) return [];
    existing.archived = true;
    existing.updatedAt = new Date().toISOString();
    return [{ name: "workspace.archived", workspace: toActuator(existing) }];
  }
}
