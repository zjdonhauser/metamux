// Pure workspace registry: upsert/re-bind rules and the derivation of
// actuator events from cmux workspace events. No I/O -- persistence is the
// caller's job (main.ts writes registry.json via paths.ts); the named-slot
// color table (from ~/.config/cmux/cmux.json) is read once by main.ts and
// injected at construction.

import { randomBytes } from "node:crypto";
import { nearestChromeGroupColor, resolveCmuxColor, TAB_GROUP_COLORS, type ChromeGroupColor } from "./colors.ts";
import type { CmuxWorkspaceEvent } from "./parser.ts";

export { TAB_GROUP_COLORS };

export interface WorkspaceRef {
  id: string; // "mw_" + 8 random hex; stable forever
  title: string;
  cwd: string | null;
  source: "cmux";
  sourceId: string; // cmux workspace UUID (per-boot stable)
  archived: boolean;
  /** Resolved cmux color as a final "#RRGGBB" hex, or null if never set
   * (or cleared). Named cmux.json slots are resolved to hex before
   * landing here -- see colors.ts's resolveCmuxColor. */
  cmuxColor: string | null;
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

  constructor(private namedSlots: Record<string, string> | null = null) {}

  private findBySourceId(sourceId: string): WorkspaceRef | null {
    for (const ref of this.workspaces.values()) {
      if (ref.source === "cmux" && ref.sourceId === sourceId) return ref;
    }
    return null;
  }

  /** Re-bind rule: match by (source, sourceId); else by (title, cwd) among
   * archived+live refs; else no match (caller creates new). */
  private findMatch(sourceId: string, title: string, cwd: string | null): WorkspaceRef | null {
    const bySourceId = this.findBySourceId(sourceId);
    if (bySourceId) return bySourceId;
    for (const ref of this.workspaces.values()) {
      if (ref.title === title && ref.cwd === cwd) return ref;
    }
    return null;
  }

  private upsert(
    sourceId: string,
    title: string,
    cwd: string | null,
  ): { ref: WorkspaceRef; changed: boolean } {
    const existing = this.findMatch(sourceId, title, cwd);
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
      source: "cmux",
      sourceId,
      archived: false,
      cmuxColor: null,
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
    const existing = this.findBySourceId(sourceId);
    if (!existing) return [];
    const resolved = resolveCmuxColor(rawColor, this.namedSlots);
    if (existing.cmuxColor === resolved) return [];
    existing.cmuxColor = resolved;
    existing.updatedAt = new Date().toISOString();
    return [{ name: "workspace.upserted", workspace: toActuator(existing) }];
  }

  /** Apply one parsed cmux workspace event to the registry, returning the
   * actuator events it derives (may be empty). */
  applyEvent(event: CmuxWorkspaceEvent): ActuatorEvent[] {
    if (event.name === "closed") {
      const existing = this.findMatch(event.workspaceId, event.title, event.cwd);
      if (!existing) return [];
      existing.archived = true;
      existing.updatedAt = new Date().toISOString();
      return [{ name: "workspace.archived", workspace: toActuator(existing) }];
    }

    if (event.name === "colored") {
      return this.applyColor(event.workspaceId, event.color ?? null);
    }

    // created, renamed, selected all upsert first.
    const { ref, changed } = this.upsert(event.workspaceId, event.title, event.cwd);
    const out: ActuatorEvent[] = [];
    if (changed) out.push({ name: "workspace.upserted", workspace: toActuator(ref) });

    if (event.name === "selected") {
      this.activeId = ref.id;
      out.push({ name: "workspace.activated", workspace: toActuator(ref) });
    }

    return out;
  }

  /** F7 window follow: activate a known workspace by its cmux sourceId
   * without touching title/cwd (a window-focus signal carries no rename
   * info, unlike a real workspace.selected event). No-op if the sourceId
   * is unknown or already active. */
  activateBySourceId(sourceId: string): ActuatorEvent[] {
    const target = this.findBySourceId(sourceId);
    if (!target || this.activeId === target.id) return [];
    this.activeId = target.id;
    return [{ name: "workspace.activated", workspace: toActuator(target) }];
  }
}
