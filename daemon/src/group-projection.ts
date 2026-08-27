// Pure title-aliasing projection for groupBy: "title" (F-groupBy). Sits
// between registry.applyEvent's raw per-workspace ActuatorEvents and the
// wire: in title mode, all same-title workspaces are aliased to one
// canonical actuator identity ("t_" + 8-hex-of-title-hash) before anything
// reaches the extension. The Registry itself is UNCHANGED and keeps full
// per-workspace fidelity -- only this projection collapses it.
//
// State kept here (not on Registry, not persisted): which title each real
// workspace id was last known under (to detect a rename as a bucket
// move), and what was last reported for each alias (to dedupe upserted
// events when an aggregate's title/color/archived hasn't actually
// changed).

import type { PaletteEntry } from "./palette.ts";
import { resolveColor, type ActuatorEvent, type ActuatorWorkspace, type ColorMode, type WorkspaceRef } from "./registry.ts";

export type GroupByMode = "title" | "workspace";

export interface GroupProjectionSnapshot {
  workspaces: WorkspaceRef[];
  activeId: string | null;
}

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** "t_" + 8 hex chars of an FNV-1a hash of the title. Stable for a given
 * title regardless of which/how-many real workspaces carry it. */
export function titleAliasId(title: string): string {
  return "t_" + fnv1a32(title).toString(16).padStart(8, "0");
}

/** The representative color inputs for a title alias: a genuinely
 * user-set cmuxColor from the first LIVE member that has one (cmuxColor
 * !== paintedColor -- see registry.ts's resolveColor for why that
 * distinction matters), and separately, a palette allocation from the
 * first live member holding one -- mirroring cmuxColor's own "first
 * non-null among live members" aggregation rule (Round 9/10), just
 * applied to two independent fields instead of one. */
function representativeColorInputs(title: string, liveMembers: WorkspaceRef[]) {
  const userColored = liveMembers.find((w) => w.cmuxColor !== null && w.cmuxColor !== w.paintedColor);
  const palettePicked = liveMembers.find((w) => w.paletteIndex !== null);
  return {
    title,
    cmuxColor: userColored?.cmuxColor ?? null,
    paintedColor: userColored?.paintedColor ?? null,
    paletteIndex: palettePicked?.paletteIndex ?? null,
  };
}

function computeBucketIdentity(
  title: string,
  snapshot: GroupProjectionSnapshot,
  colorMode: ColorMode,
  palette: PaletteEntry[],
): ActuatorWorkspace | null {
  const members = snapshot.workspaces.filter((w) => w.title === title);
  if (members.length === 0) return null;

  const liveMembers = members.filter((w) => !w.archived);
  const allArchived = liveMembers.length === 0;

  return {
    id: titleAliasId(title),
    title,
    color: resolveColor(representativeColorInputs(title, liveMembers), colorMode, palette),
    archived: allArchived,
  };
}

export class GroupProjection {
  private lastKnownTitle = new Map<string, string>(); // real workspace id -> title, to detect renames
  private lastEmitted = new Map<string, ActuatorWorkspace>(); // alias id -> last reported aggregate (title mode dedupe)

  constructor(
    private groupBy: GroupByMode,
    private colorMode: ColorMode = "palette",
    private palette: PaletteEntry[] = [],
  ) {}

  setGroupBy(mode: GroupByMode): void {
    this.groupBy = mode;
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
  }

  /** The wire identity for a workspace ref: itself in workspace mode, its
   * title's alias aggregate in title mode. */
  identityFor(ref: WorkspaceRef, snapshot: GroupProjectionSnapshot): ActuatorWorkspace {
    if (this.groupBy === "workspace") {
      return { id: ref.id, title: ref.title, color: resolveColor(ref, this.colorMode, this.palette), archived: ref.archived };
    }
    return computeBucketIdentity(ref.title, snapshot, this.colorMode, this.palette)!; // ref is itself a member, never null
  }

  /** Maps a wire identity id back to a real workspace id to act on
   * (reverse sync): itself in workspace mode; in title mode, the alias's
   * currently-active member if any, else its first live member. null if
   * the identity isn't known. */
  resolveIdentityToWorkspaceId(id: string, snapshot: GroupProjectionSnapshot): string | null {
    if (this.groupBy === "workspace") {
      return snapshot.workspaces.some((w) => w.id === id) ? id : null;
    }
    for (const candidate of snapshot.workspaces) {
      if (titleAliasId(candidate.title) !== id) continue;
      const members = snapshot.workspaces.filter((w) => w.title === candidate.title);
      const activeMember = members.find((w) => w.id === snapshot.activeId && !w.archived);
      if (activeMember) return activeMember.id;
      const liveMember = members.find((w) => !w.archived);
      return liveMember ? liveMember.id : null;
    }
    return null;
  }

  /** Real workspace ids composing a wire identity (detach-on-close,
   * userClosedGroup): itself in workspace mode (if it exists), else `[]`;
   * in title mode, every real workspace sharing that alias's title, live
   * OR archived. Closing the aggregate group clears attachment for the
   * whole alias, not just its currently-active member -- otherwise a
   * still-attached sibling would keep the alias included via the union
   * rule (docs/protocol.md, groupBy: "title" -- "any member attached"),
   * and the group would never actually disappear. */
  membersOf(id: string, snapshot: GroupProjectionSnapshot): string[] {
    if (this.groupBy === "workspace") {
      return snapshot.workspaces.some((w) => w.id === id) ? [id] : [];
    }
    for (const candidate of snapshot.workspaces) {
      if (titleAliasId(candidate.title) !== id) continue;
      return snapshot.workspaces.filter((w) => w.title === candidate.title).map((w) => w.id);
    }
    return [];
  }

  /** The wire id of the currently active identity: registry.activeId
   * itself in workspace mode; its alias in title mode. */
  currentActiveIdentity(snapshot: GroupProjectionSnapshot): string | null {
    if (this.groupBy === "workspace") return snapshot.activeId;
    if (snapshot.activeId === null) return null;
    const activeRef = snapshot.workspaces.find((w) => w.id === snapshot.activeId);
    return activeRef ? titleAliasId(activeRef.title) : null;
  }

  /** Projects one raw actuator event (real per-workspace id, from
   * registry.applyEvent) into the events to actually broadcast. Pass-
   * through in workspace mode. In title mode: recomputes the affected
   * title's aggregate, deduping against what was last reported; detects a
   * rename (title changed since this workspace id was last seen) as a
   * bucket move, reporting the old bucket archived-if-now-empty and the
   * new bucket's upsert. */
  project(raw: ActuatorEvent, snapshot: GroupProjectionSnapshot): ActuatorEvent[] {
    if (this.groupBy === "workspace") return [raw];

    const workspaceId = raw.workspace.id;
    const newTitle = raw.workspace.title;
    const oldTitle = this.lastKnownTitle.get(workspaceId);
    this.lastKnownTitle.set(workspaceId, newTitle);

    const out: ActuatorEvent[] = [];
    if (oldTitle !== undefined && oldTitle !== newTitle) {
      out.push(...this.emitBucketUpdate(oldTitle, snapshot, false));
    }
    out.push(...this.emitBucketUpdate(newTitle, snapshot, raw.name === "workspace.activated"));
    return out;
  }

  private emitBucketUpdate(title: string, snapshot: GroupProjectionSnapshot, wasActivated: boolean): ActuatorEvent[] {
    const aliasId = titleAliasId(title);
    const identity = computeBucketIdentity(title, snapshot, this.colorMode, this.palette);

    if (!identity) {
      // Zero members left under this title (a rename moved the last one
      // away). If this alias was previously reported, tell the client
      // it's now gone -- the "archived" rule's degenerate case. Never
      // reported -> nothing to report.
      const prevGone = this.lastEmitted.get(aliasId);
      if (prevGone && !prevGone.archived) {
        const goneIdentity: ActuatorWorkspace = { ...prevGone, archived: true };
        this.lastEmitted.set(aliasId, goneIdentity);
        return [{ name: "workspace.archived", workspace: goneIdentity }];
      }
      return [];
    }

    const out: ActuatorEvent[] = [];
    const prev = this.lastEmitted.get(identity.id);
    const changed = !prev || prev.title !== identity.title || prev.color !== identity.color || prev.archived !== identity.archived;
    if (changed) {
      this.lastEmitted.set(identity.id, identity);
      out.push({ name: identity.archived ? "workspace.archived" : "workspace.upserted", workspace: identity });
    }
    if (wasActivated && !identity.archived) {
      out.push({ name: "workspace.activated", workspace: identity });
    }
    return out;
  }

  /** The full current sync-frame identity list: one entry per real
   * workspace in workspace mode, one per distinct title in title mode. */
  projectState(snapshot: GroupProjectionSnapshot): { activeId: string | null; workspaces: ActuatorWorkspace[] } {
    if (this.groupBy === "workspace") {
      return {
        activeId: snapshot.activeId,
        workspaces: snapshot.workspaces.map((ref) => ({
          id: ref.id,
          title: ref.title,
          color: resolveColor(ref, this.colorMode, this.palette),
          archived: ref.archived,
        })),
      };
    }

    const seenTitles = new Set<string>();
    const identities: ActuatorWorkspace[] = [];
    for (const ref of snapshot.workspaces) {
      if (seenTitles.has(ref.title)) continue;
      seenTitles.add(ref.title);
      identities.push(computeBucketIdentity(ref.title, snapshot, this.colorMode, this.palette)!);
    }
    return { activeId: this.currentActiveIdentity(snapshot), workspaces: identities };
  }
}
