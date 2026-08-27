// Pure workspace registry: upsert/re-bind rules and the derivation of
// actuator events from cmux workspace events. No I/O -- persistence is the
// caller's job (main.ts writes registry.json via paths.ts); the named-slot
// color table (from ~/.config/cmux/cmux.json) is read once by main.ts and
// injected at construction.

import { randomBytes } from "node:crypto";
import { nearestChromeGroupColor, resolveCmuxColor, TAB_GROUP_COLORS, type ChromeGroupColor } from "./colors.ts";
import { claimPaletteIndex, type PaletteHolder } from "./palette-allocator.ts";
import type { PaletteEntry } from "./palette.ts";
import type { CmuxWorkspaceEvent } from "./parser.ts";
import type { RegistryIntent } from "./tmux-reconcile.ts";

export type ColorMode = "palette" | "hash";

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
  /** colorMode: "palette" allocation (palette-allocator.ts): the index
   * into the loaded palette.ts entries this ref currently holds, or null
   * if it's never attached, was released (detach/archive), or colorMode
   * is "hash". Cleared (not just left stale) on every archive/detach so a
   * later re-attach always claims fresh -- see Registry.claimPaletteColor
   * and its release call sites. Persisted so a restart doesn't reshuffle
   * every still-attached identity's color. */
  paletteIndex: number | null;
  /** Window pairing (docs/protocol.md, "Window pairing"): the id of the
   * cmux window hosting this ref's tab, or null. Set ONLY by tmux-
   * reconcile.ts's partition mode (source: "tmux" refs) via
   * applyTmuxIntent -- cmux-sourced refs never carry this (their own
   * activation/window-follow events don't report a window id; see
   * cmux-actuator.ts's ActuatorWindow discussion). Combined with
   * Registry.windowPairings, resolves to a group's HOME Chrome window. */
  cmuxWindowId: string | null;
  /** Placement ownership (docs/protocol.md, "Placement ownership"): a
   * Chrome window id the user has explicitly moved this identity's group
   * to, overriding its home window -- or null if it still lives at home.
   * Set/cleared via the ext->daemon `groupPlacement` frame
   * (Registry.setPlacementOverride); cleared automatically on detach
   * (server.ts's userClosedGroup handling), matching the contract's
   * "override clears with detach". */
  placementOverride: string | null;
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
 * deterministic hash of the title: sum of UTF-16 char codes mod 9. This is
 * ONLY the title-hash fallback -- resolveColor below is the actual
 * colorMode-aware precedence used everywhere on the wire. */
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

export interface ColorInputs {
  title: string;
  cmuxColor: string | null;
  paintedColor: string | null;
  paletteIndex: number | null;
}

/** Full color-resolution precedence, colorMode-aware:
 * 1. A genuinely USER-set cmuxColor -- cmuxColor !== paintedColor, the
 *    same ownership signature color-backflow.ts already uses to tell "the
 *    user set this" apart from "this is our own paint echoing back
 *    through the colored event" -- hue-mapped to the nearest Chrome color.
 * 2. In colorMode: "palette", the ref's allocated palette entry
 *    (palette.ts): an EXPLICIT per-entry choice, never hue-mapped.
 *    Excluding step 1's own paint from hue-mapping matters here: a
 *    backflow-painted brand hex whose palette entry says e.g. "grey"
 *    could otherwise hue-map to a DIFFERENT Chrome color (Navy #152744
 *    hue-maps to "blue" per colors.ts), flipping the group's color one
 *    backflow cycle after allocation -- the paintedColor check in step 1
 *    is what prevents that.
 * 3. The title hash (colorFor) -- the ultimate fallback, and the entire
 *    behavior in colorMode: "hash". */
export function resolveColor(input: ColorInputs, colorMode: ColorMode, palette: PaletteEntry[]): ChromeGroupColor {
  const userSet = input.cmuxColor !== null && input.cmuxColor !== input.paintedColor;
  if (userSet) {
    const mapped = nearestChromeGroupColor(input.cmuxColor!);
    if (mapped) return mapped;
  }
  if (colorMode === "palette" && input.paletteIndex !== null) {
    const entry = palette[input.paletteIndex];
    if (entry) return entry.chromeColor;
  }
  return colorFor(input.title);
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
  /** groupBy (title-aliasing vs one identity per real workspace): mirrors
   * GroupProjection's own mode. Kept here too because palette allocation
   * happens at the moment of attachment (markAttached) and needs to know
   * the allocation UNIT -- a title alias's members share one claim, a
   * real workspace's don't. Mutable for the same hot-reload reason as
   * attachOnActivate; main.ts keeps both in lockstep with config.groupBy. */
  groupBy: "title" | "workspace" = "title";
  /** colorMode: "palette" (default) allocates a distinguishable palette
   * entry per identity at attachment time (see markAttached);
   * "hash" disables allocation and every identity without a user-set
   * color falls back to colorFor's title hash. Mutable, hot-reloadable. */
  colorMode: ColorMode = "palette";

  constructor(
    private namedSlots: Record<string, string> | null = null,
    private palette: PaletteEntry[] = [],
  ) {}

  private toActuator(ref: WorkspaceRef): ActuatorWorkspace {
    return { id: ref.id, title: ref.title, color: resolveColor(ref, this.colorMode, this.palette), archived: ref.archived };
  }

  /** Claims this ref's palette index (colorMode: "palette" only -- see
   * markAttached, the sole caller): the lowest index not held by any
   * OTHER live, attached identity sharing its groupBy unit. Idempotent
   * and stable for an identity that already holds a live index -- see
   * palette-allocator.ts's claimPaletteIndex for the full contract.
   * No-op when the palette is empty (colorMode: "hash", or an unreadable
   * cmux.json with no fallback loaded -- shouldn't happen in practice,
   * palette.ts always returns a non-empty list, but stays defensive). */
  private claimPaletteColor(id: string): void {
    if (this.palette.length === 0) return;
    const ref = this.workspaces.get(id);
    if (!ref) return;
    const identityKey = this.groupBy === "title" ? ref.title : ref.id;
    const holders: PaletteHolder[] = [...this.workspaces.values()].map((other) => ({
      identityKey: this.groupBy === "title" ? other.title : other.id,
      live: !other.archived && other.attachedAt !== null,
      paletteIndex: other.paletteIndex,
    }));
    ref.paletteIndex = claimPaletteIndex(identityKey, holders, this.palette.length);
  }

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

  /** `cmuxWindowId`, when passed, is written on both create and update --
   * only tmux-reconcile.ts's partition-mode intents pass it (see
   * applyTmuxIntent). Omitted (undefined), it's left untouched on an
   * existing ref (legacy windows/global modes and cmux-sourced upserts
   * never pass it) and defaults to null on a fresh ref. */
  private upsert(
    source: WorkspaceSource,
    sourceId: string,
    title: string,
    cwd: string | null,
    cmuxWindowId?: string,
  ): { ref: WorkspaceRef; changed: boolean } {
    const existing = this.findMatch(source, sourceId, title, cwd);
    if (existing) {
      const changed =
        existing.title !== title ||
        existing.cwd !== cwd ||
        existing.sourceId !== sourceId ||
        existing.archived || // unarchiving counts as a change worth an upsert event
        (cmuxWindowId !== undefined && existing.cmuxWindowId !== cmuxWindowId);
      existing.title = title;
      existing.cwd = cwd;
      existing.sourceId = sourceId;
      existing.archived = false;
      if (cmuxWindowId !== undefined) existing.cmuxWindowId = cmuxWindowId;
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
      paletteIndex: null,
      cmuxWindowId: cmuxWindowId ?? null,
      placementOverride: null,
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
    return [{ name: "workspace.upserted", workspace: this.toActuator(existing) }];
  }

  /** Marks a workspace attached (idempotent -- the first call for a given
   * id records the timestamp; later calls are no-ops). Called on
   * activation (selected, window follow) when attachOnActivate is true,
   * and always when open_url targets a workspace directly (server.ts).
   * Attachment is also palette allocation's trigger point (docs/
   * protocol.md's "Palette allocation" section): a fresh attachment
   * claims a palette color in colorMode: "palette", the same instant a
   * group is actually created. No-op for an unknown id or one already
   * attached. */
  markAttached(id: string, atIso: string = new Date().toISOString()): void {
    const ref = this.workspaces.get(id);
    if (!ref || ref.attachedAt !== null) return;
    ref.attachedAt = atIso;
    if (this.colorMode === "palette") this.claimPaletteColor(id);
  }

  /** Detach-on-close (userClosedGroup): clears a workspace's attachedAt so
   * createGroups' lazy filter stops including it until it's reopened, and
   * releases its palette color claim (palette-allocator.ts) -- a
   * re-attach later claims fresh and may land on a different color, by
   * design (Zac: "frees back up"). Also clears placementOverride (docs/
   * protocol.md, "Placement ownership": "override clears with detach") --
   * a re-opened group starts back at its home window. No-op for an
   * unknown id or one already unattached. */
  clearAttached(id: string): void {
    const ref = this.workspaces.get(id);
    if (!ref) return;
    ref.attachedAt = null;
    ref.paletteIndex = null;
    ref.placementOverride = null;
  }

  /** ext->daemon `groupPlacement` frame: records (or clears, with
   * `chromeWindowId: null`) a user-driven move of this identity's group to
   * a Chrome window other than its home -- see WorkspaceRef.placementOverride.
   * No-op for an unknown id or an unchanged value. */
  setPlacementOverride(id: string, chromeWindowId: string | null): ActuatorEvent[] {
    const ref = this.workspaces.get(id);
    if (!ref || ref.placementOverride === chromeWindowId) return [];
    ref.placementOverride = chromeWindowId;
    ref.updatedAt = new Date().toISOString();
    return [{ name: "workspace.upserted", workspace: this.toActuator(ref) }];
  }

  /** Chrome window pairing (docs/protocol.md, "Chrome window pairing"):
   * cmux window id -> paired Chrome window id, persisted alongside the
   * workspace map. Set by the extension-reported window-pairing frame
   * (main.ts), resolved by marker tab per the contract. */
  windowPairings: Map<string, string> = new Map();

  /** Records (or overwrites) one cmux-window -> Chrome-window pairing. */
  setWindowPairing(cmuxWindowId: string, chromeWindowId: string): void {
    this.windowPairings.set(cmuxWindowId, chromeWindowId);
  }

  /** The paired Chrome window for a cmux window id, or null if unpaired
   * (or the ref carries no cmux window at all -- legacy windows/global
   * modes, or a cmux-sourced ref). */
  homeChromeWindowId(cmuxWindowId: string | null): string | null {
    if (cmuxWindowId === null) return null;
    return this.windowPairings.get(cmuxWindowId) ?? null;
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
      // Release the palette claim on archive, not just at detach: attachedAt
      // survives archive (a still-attached-but-archived ref can unarchive
      // later via upsert without going through markAttached again), so
      // leaving paletteIndex stamped here would let it silently come back
      // live holding a slot someone else may have claimed meanwhile.
      existing.paletteIndex = null;
      existing.updatedAt = new Date().toISOString();
      return [{ name: "workspace.archived", workspace: this.toActuator(existing) }];
    }

    if (event.name === "colored") {
      return this.applyColor(event.workspaceId, event.color ?? null);
    }

    // created, renamed, selected all upsert first.
    const { ref, changed } = this.upsert("cmux", event.workspaceId, event.title, event.cwd);
    const out: ActuatorEvent[] = [];
    if (changed) out.push({ name: "workspace.upserted", workspace: this.toActuator(ref) });

    if (event.name === "selected") {
      this.activeId = ref.id;
      if (this.attachOnActivate) this.markAttached(ref.id);
      out.push({ name: "workspace.activated", workspace: this.toActuator(ref) });
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
    return [{ name: "workspace.activated", workspace: this.toActuator(target) }];
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
      existing.paletteIndex = null; // release the palette claim, same as applyEvent's closed branch
      existing.updatedAt = new Date().toISOString();
      return [{ name: "workspace.archived", workspace: this.toActuator(existing) }];
    }
    const { ref, changed } = this.upsert("tmux", intent.sessionId, intent.sessionName, null, intent.cmuxWindowId);
    return changed ? [{ name: "workspace.upserted", workspace: this.toActuator(ref) }] : [];
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
    return [{ name: "workspace.upserted", workspace: this.toActuator(existing) }];
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
    existing.paletteIndex = null; // release the palette claim, same as applyEvent's closed branch
    existing.updatedAt = new Date().toISOString();
    return [{ name: "workspace.archived", workspace: this.toActuator(existing) }];
  }

  /** Registry compaction: removes archived refs from the registry -- ALL
   * of them when `cutoffIso` is null (manual /prune, `metamux prune`), or
   * only those with `updatedAt` strictly older than `cutoffIso`
   * (auto-compact on startup, config.pruneArchivedAfterDays). Live
   * (unarchived) refs are NEVER touched regardless. Returns the removed
   * refs for logging/CLI output. Not destructive in any lasting sense: a
   * pruned ref's cmux workspace, if ever seen again, simply creates a
   * fresh ref via the normal upsert-with-no-match path (a new `mw_` id,
   * a new Chrome group) -- exactly as if metamux had never seen it
   * before. Alias-level grouping (groupBy: "title") needs no separate
   * cleanup here: it's computed fresh from `this.workspaces` on every
   * projection, so a title with zero remaining members simply stops
   * appearing, automatically. */
  pruneArchived(cutoffIso: string | null): WorkspaceRef[] {
    const removed: WorkspaceRef[] = [];
    for (const [id, ref] of this.workspaces) {
      if (!ref.archived) continue;
      if (cutoffIso !== null && ref.updatedAt >= cutoffIso) continue;
      removed.push(ref);
      this.workspaces.delete(id);
    }
    return removed;
  }
}
