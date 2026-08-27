// Pure decision logic for color backflow: paint a cmux tab's own color to
// match its Chrome group, so the two visually agree at a glance ("a
// colored flag that matches the color of the browser tab the cmux tab
// relates to" -- Zac). Only ever acts when the Chrome group's color is
// the TITLE-HASH FALLBACK (no live member has a user-set cmuxColor) --
// backflow never invents a color for a group the user already colored,
// it only extends an already-existing color outward onto the cmux side.
//
// No I/O -- daemon/src/main.ts's poll loop is the thin wrapper that reads
// the registry, calls this, and executes the resulting actions via
// cmux-actuator.ts.

import { colorFor } from "./registry.ts";
import { CHROME_GROUP_REPRESENTATIVE_HEX, type ChromeGroupColor } from "./colors.ts";

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
  archived: boolean;
}

export interface BackflowCandidate {
  refId: string;
  cmuxWorkspaceId: string;
  /** The Chrome group color this ref's identity currently resolves to. */
  identityColor: ChromeGroupColor;
  /** Whether that identityColor came from a real, user-set cmuxColor
   * (true) or the title-hash fallback (false) -- decideBackflow only
   * acts when this is false. */
  hasRealColor: boolean;
  cmuxColor: string | null;
  paintedColor: string | null;
}

/** Groups live cmux-sourced refs by their groupBy identity (title in
 * "title" mode, the ref itself in "workspace" mode) and resolves each
 * group's Chrome color exactly the way group-projection.ts's
 * computeBucketIdentity does (first live member's cmuxColor as the
 * representative, else the title-hash fallback) -- so backflow's notion
 * of "the Chrome group's color" always matches what the extension is
 * actually showing. Archived refs and tmux-sourced refs (nothing to
 * paint via `cmux workspace-action` for a tmux session id) are excluded.
 * Pure: same refs + groupBy, same candidates, every time. */
export function computeBackflowCandidates(refs: BackflowRef[], groupBy: "title" | "workspace"): BackflowCandidate[] {
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
    const representativeColor = members.find((m) => m.cmuxColor !== null)?.cmuxColor ?? null;
    const hasRealColor = representativeColor !== null;
    const identityColor = colorFor(members[0]!.title, representativeColor);
    for (const ref of members) {
      out.push({
        refId: ref.id,
        cmuxWorkspaceId: ref.sourceId,
        identityColor,
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
  identityColor: ChromeGroupColor;
  hasRealColor: boolean;
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
 * whether it's reporting the user's action or our own echo). */
export function decideBackflow(input: DecideBackflowInput): BackflowDecision {
  if (input.hasRealColor) return { action: "skip", reason: "no-fallback-color" };

  const userOwned = input.ref.cmuxColor !== null && input.ref.cmuxColor !== input.ref.paintedColor;
  if (userOwned) return { action: "skip", reason: "user-owned" };

  const targetHex = CHROME_GROUP_REPRESENTATIVE_HEX[input.identityColor];
  if (input.ref.cmuxColor === targetHex) return { action: "skip", reason: "already-matches" };
  return { action: "paint", targetHex };
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
      identityColor: c.identityColor,
      hasRealColor: c.hasRealColor,
      ref: { cmuxColor: c.cmuxColor, paintedColor: c.paintedColor },
    });
    if (decision.action === "paint") {
      actions.push({ refId: c.refId, cmuxWorkspaceId: c.cmuxWorkspaceId, targetHex: decision.targetHex });
    }
  }
  return actions;
}
