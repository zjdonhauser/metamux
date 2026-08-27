// One-time state migration (docs/tmux-port-plan.md §3.1(b)/§5 Phase 5):
// reclassifies existing cmux-sourced WorkspaceRefs that tmux-cmux-sync
// already created into tmux-sourced refs, using its last-written state
// file to find them. Pure planning function + a thin loader for the state
// file -- the actual registry mutation happens at the call site (main.ts)
// via Registry.reclassifyAsTmux/archiveBySourceId, not here, so this stays
// decoupled from registry.ts.

import { readFile } from "node:fs/promises";
import { expandHome } from "./paths.ts";

/** tmux-cmux-sync.json, windows mode: {windowUUID: {sessionName:
 * cmuxWorkspaceUUID}}. Global mode's shape ({sessionName: cmuxWorkspaceUUID},
 * one level shallower) isn't handled here -- Zac's live install has always
 * run the default "windows" mode (docs/tmux-port-plan.md §1.2), and a
 * global-mode legacy file simply parses to no windows worth migrating
 * (every value is a string, not an object, so the inner Object.entries
 * loop below finds nothing to iterate) rather than crashing. */
export type LegacyTmuxSyncState = Record<string, Record<string, string>>;

export const DEFAULT_LEGACY_STATE_PATH = "~/.local/state/tmux-cmux-sync.json";

/** Tolerant load: missing file, invalid JSON, or the global-mode shape all
 * produce an empty state rather than throwing -- this migration only ever
 * adds information, so "nothing to migrate" is always a safe outcome. */
export async function loadLegacyState(path: string = DEFAULT_LEGACY_STATE_PATH): Promise<LegacyTmuxSyncState> {
  try {
    const text = await readFile(expandHome(path), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: LegacyTmuxSyncState = {};
    for (const [windowId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue; // global-mode shape -- skip
      const bySession: Record<string, string> = {};
      for (const [sessionName, cmuxSourceId] of Object.entries(value as Record<string, unknown>)) {
        if (typeof cmuxSourceId === "string") bySession[sessionName] = cmuxSourceId;
      }
      out[windowId] = bySession;
    }
    return out;
  } catch {
    return {};
  }
}

export interface MigrationPlan {
  /** One reclassify per live tmux session found in the legacy state:
   * which existing cmux WorkspaceRef (by its cmux sourceId) becomes the
   * new tmux-sourced ref of record, keeping that ref's mw_ id (and Chrome
   * group) alive across the migration. */
  reclassify: { cmuxSourceId: string; sessionId: string; sessionName: string }[];
  /** Every OTHER cmux ref that mirrored the same session in a different
   * window: no longer an independent registry identity post-migration --
   * the cmux tab itself is untouched (it becomes an actuator-tracked
   * attachment, not a registry member) -- so it's archived, scoped to
   * "cmux" (never accidentally archives the tmux ref itself). */
  archive: { source: "cmux"; cmuxSourceId: string }[];
}

export function emptyMigrationPlan(): MigrationPlan {
  return { reclassify: [], archive: [] };
}

/** `sessionsByName`: live tmux sessions (name -> id) from tmux-source.ts's
 * listSessions(), used to resolve the legacy state's session NAMES (all
 * the old tool ever tracked) to the stable session IDs the new registry
 * model needs. A name with no live matching session is dropped -- it no
 * longer exists, so there's nothing to reclassify for it; a normal
 * reconcile tick handles anything new going forward, this migration only
 * concerns itself with what's alive right now. Pure: same inputs, same
 * plan, every time. */
export function planMigration(legacy: LegacyTmuxSyncState, sessionsByName: Map<string, string>): MigrationPlan {
  const reclassify: MigrationPlan["reclassify"] = [];
  const archive: MigrationPlan["archive"] = [];
  const claimedSessionNames = new Set<string>();

  for (const bySession of Object.values(legacy)) {
    for (const [sessionName, cmuxSourceId] of Object.entries(bySession)) {
      const sessionId = sessionsByName.get(sessionName);
      if (!sessionId) continue; // session no longer exists

      if (claimedSessionNames.has(sessionName)) {
        archive.push({ source: "cmux", cmuxSourceId });
        continue;
      }
      claimedSessionNames.add(sessionName);
      reclassify.push({ cmuxSourceId, sessionId, sessionName });
    }
  }

  return { reclassify, archive };
}
