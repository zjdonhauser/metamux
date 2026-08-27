// Pure decision logic for color backflow: paint a cmux tab's own color to
// match its Chrome group, so the two visually agree at a glance ("a
// colored flag that matches the color of the browser tab the cmux tab
// relates to" -- Zac). Only ever acts when the Chrome group's color is
// NOT a real, user-set one (no live member has a cmuxColor that differs
// from what we last painted) -- backflow never invents a color for a
// group the user already colored, it only extends an already-existing
// color (the title-hash fallback in colorMode: "hash", or the allocated
// palette entry in colorMode: "palette") outward onto the cmux side.
//
// In colorMode: "palette", the hex painted is the SPECIFIC allocated
// palette.ts entry's hex, not a Chrome-representative hex -- distinct
// identities land on visually distinct brand colors on the cmux side too,
// not just on the 9-color Chrome side. registry.ts's resolveColor is what
// keeps this from fighting with hue-mapping on the next tick: once this
// hex round-trips through the tailed `colored` event and paintedColor
// catches up to match it (registry.ts's markPainted), cmuxColor ===
// paintedColor holds and hue-mapping is skipped for this ref from then on.
//
// No I/O -- daemon/src/main.ts's poll loop is the thin wrapper that reads
// the registry, calls this, and executes the resulting actions via
// cmux-actuator.ts.

import { resolveColor, type ColorMode } from "./registry.ts";
import { CHROME_GROUP_REPRESENTATIVE_HEX, type ChromeGroupColor } from "./colors.ts";
import type { PaletteEntry } from "./palette.ts";

export interface BackflowRef {
  id: string; // registry WorkspaceRef.id
  source: "cmux" | "tmux";
  sourceId: string; // the cmux workspace UUID to paint (source: "cmux" refs only)
  title: string;
  cmuxColor: string | null;
  /** The hex WE last painted onto this ref, or null if we never have.
   * This is what distinguishes "the user set this color" from "this is
   * just our own paint echoing back" -- see decideBackflow. */
  paintedColor: string | null;
  /** colorMode: "palette" allocation (palette-allocator.ts): the index
   * into the loaded palette this ref currently holds, or null. */
  paletteIndex: number | null;
  archived: boolean;
}

export interface BackflowCandidate {
  refId: string;
  cmuxWorkspaceId: string;
  /** The Chrome group color this ref's identity currently resolves to
   * (registry.ts's resolveColor -- same precedence the wire protocol
   * uses). */
  identityColor: ChromeGroupColor;
  /** The hex backflow should paint if it decides to act at all: the
   * allocated palette entry's hex when one is held in colorMode:
   * "palette", else the Chrome-representative hex for identityColor (the
   * entire behavior in colorMode: "hash", and palette mode's own
   * fallback before an identity has attached/claimed one). */
  targetHex: string;
  /** Whether identityColor came from a real, user-set cmuxColor (true) --
   * decideBackflow only acts when this is false, regardless of
   * colorMode. */
  hasRealColor: boolean;
  cmuxColor: string | null;
  paintedColor: string | null;
}

/** Groups live cmux-sourced refs by their groupBy identity (title in
 * "title" mode, the ref itself in "workspace" mode) and resolves each
 * group's color exactly the way group-projection.ts's computeBucketIdentity
 * does (registry.ts's resolveColor, colorMode-aware) -- so backflow's
 * notion of "the Chrome group's color" always matches what the extension
 * is actually showing. Archived refs and tmux-sourced refs (nothing to
 * paint via `cmux workspace-action` for a tmux session id) are excluded.
 * Pure: same refs + groupBy + colorMode + palette, same candidates, every
 * time. */
export function computeBackflowCandidates(
  refs: BackflowRef[],
  groupBy: "title" | "workspace",
  colorMode: ColorMode,
  palette: PaletteEntry[],
): BackflowCandidate[] {
  const live = refs.filter((r) => r.source === "cmux" && !r.archived);
  const groups = new Map<string, BackflowRef[]>();
  for (const ref of live) {
    const key = groupBy === "title" ? ref.title : ref.id;
    const members = groups.get(key);
    if (members) members.push(ref);
    else groups.set(key, [ref]);
  }

  const out: BackflowCandidate[] = [];
  for (const members of groups.values()) {
    const userColored = members.find((m) => m.cmuxColor !== null && m.cmuxColor !== m.paintedColor);
    const hasRealColor = userColored !== undefined;
    const palettePicked = members.find((m) => m.paletteIndex !== null);

    const identityColor = resolveColor(
      {
        title: members[0]!.title,
        cmuxColor: userColored?.cmuxColor ?? null,
        paintedColor: userColored?.paintedColor ?? null,
        paletteIndex: palettePicked?.paletteIndex ?? null,
      },
      colorMode,
      palette,
    );
    const allocatedHex = colorMode === "palette" && palettePicked ? palette[palettePicked.paletteIndex!]?.hex : undefined;
    const targetHex = allocatedHex ?? CHROME_GROUP_REPRESENTATIVE_HEX[identityColor];

    for (const ref of members) {
      out.push({
        refId: ref.id,
        cmuxWorkspaceId: ref.sourceId,
        identityColor,
        targetHex,
        hasRealColor,
        cmuxColor: ref.cmuxColor,
        paintedColor: ref.paintedColor,
      });
    }
  }
  return out;
}

export type BackflowDecision =
  | { action: "paint"; targetHex: string }
  | { action: "skip"; reason: "no-fallback-color" | "user-owned" | "already-matches" };

export interface DecideBackflowInput {
  hasRealColor: boolean;
  /** The hex to paint if this decides to act -- the Chrome-representative
   * hex in colorMode: "hash", or the allocated palette entry's hex in
   * colorMode: "palette" (BackflowCandidate.targetHex, already resolved
   * by computeBackflowCandidates). */
  targetHex: string;
  ref: { cmuxColor: string | null; paintedColor: string | null };
}

/** The paint/skip/repaint matrix, in full:
 *
 * | cmuxColor | paintedColor | hasRealColor | decision                    |
 * |-----------|--------------|--------------|-----------------------------|
 * | (any)     | (any)        | true         | skip: no-fallback-color     |
 * | null      | null         | false        | paint (never touched)       |
 * | null      | <hex>        | false        | paint (user cleared OUR paint -> repaint) |
 * | X         | X            | false        | skip: already-matches (X == target) or paint (X != target, our own stale paint) |
 * | X         | Y (Y != X)   | false        | skip: user-owned (X is the user's, not ours) |
 * | X         | null         | false        | skip: user-owned (never painted, so X is the user's) |
 *
 * The eligibility rule collapses to one check: a ref is ours to paint
 * unless it carries a REAL color (cmuxColor !== null) that ISN'T what we
 * last painted (cmuxColor !== paintedColor) -- that combination is the
 * only signature a user-set color can produce, since backflow itself
 * never writes cmuxColor directly (only the tailed `colored` event does,
 * whether it's reporting the user's action or our own echo). This matrix
 * is unchanged by colorMode -- only where targetHex comes from differs
 * (see computeBackflowCandidates). */
export function decideBackflow(input: DecideBackflowInput): BackflowDecision {
  if (input.hasRealColor) return { action: "skip", reason: "no-fallback-color" };

  const userOwned = input.ref.cmuxColor !== null && input.ref.cmuxColor !== input.ref.paintedColor;
  if (userOwned) return { action: "skip", reason: "user-owned" };

  if (input.ref.cmuxColor === input.targetHex) return { action: "skip", reason: "already-matches" };
  return { action: "paint", targetHex: input.targetHex };
}

export interface BackflowAction {
  refId: string;
  cmuxWorkspaceId: string;
  targetHex: string;
}

/** Runs decideBackflow across every candidate and returns only the
 * "paint" actions -- the list the caller hands to cmux-actuator.ts's
 * setTabColor. Pure. */
export function planBackflow(candidates: BackflowCandidate[]): BackflowAction[] {
  const actions: BackflowAction[] = [];
  for (const c of candidates) {
    const decision = decideBackflow({
      hasRealColor: c.hasRealColor,
      targetHex: c.targetHex,
      ref: { cmuxColor: c.cmuxColor, paintedColor: c.paintedColor },
    });
    if (decision.action === "paint") {
      actions.push({ refId: c.refId, cmuxWorkspaceId: c.cmuxWorkspaceId, targetHex: decision.targetHex });
    }
  }
  return actions;
}
