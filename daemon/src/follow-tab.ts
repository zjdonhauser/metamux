// Pure decision for follow-the-tab: a workspace moved between cmux windows, so
// its Chrome tab group should move to the paired Chrome window.
//
// This is the behavior marker-tab identity could never express. Today a group
// appearing in an unexpected window is indistinguishable from the user having
// dragged it there, which is why placementOverride resolves the ambiguity
// bluntly: assume the user did it, stop touching the group. A CONFIRMED change
// of cmuxWindowId is what finally tells the two apart.
//
// Every uncertain input returns null. Doing nothing leaves the group where it
// is, which is always recoverable; moving it wrongly is not.

export interface FollowTabInput {
  enabled: boolean;
  /** False when the one-per-Space invariant broke or the helper went stale. */
  pairingHealthy: boolean;
  /** The title alias whose group would move, or null if it has none yet. */
  aliasId: string | null;
  previousCmuxWindowId: string | null;
  currentCmuxWindowId: string | null;
  chromeWindowForCurrent: number | null;
  chromeWindowForPrevious: number | null;
}

export interface FollowTabMove {
  kind: "move";
  aliasId: string;
  toChromeWindowId: number;
}

export function decideFollowTab(input: FollowTabInput): FollowTabMove | null {
  if (!input.enabled || !input.pairingHealthy) return null;
  if (!input.aliasId) return null;

  const { previousCmuxWindowId: from, currentCmuxWindowId: to } = input;
  // No previous window is a first sighting, not a move.
  if (!from || !to || from === to) return null;

  const target = input.chromeWindowForCurrent;
  if (target === null) return null;
  // Both cmux windows already share one Chrome window: nothing to do.
  if (input.chromeWindowForPrevious === target) return null;

  return { kind: "move", aliasId: input.aliasId, toChromeWindowId: target };
}
