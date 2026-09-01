import type { ChromeWindowId, CmuxWindowId, WindowPair } from "./identity.ts";

/**
 * One confirmed sighting of a cmux window and a Chrome window sharing a
 * display. Produced by the geometry join, and only while BOTH are visible.
 */
export interface PairObservation {
  cmuxWindowId: CmuxWindowId;
  chromeWindowId: ChromeWindowId;
}

export interface PairResolution {
  pairs: WindowPair[];
  changed: boolean;
}

/**
 * Keeps the durable cmux-window to Chrome-window pairing.
 *
 * The rule is derive when visible, remember when not. Geometry is consulted
 * only to REPAIR a pairing, never to answer "which Chrome window" on every
 * pass. That is what fixes the failure we hit live, where follow-the-tab
 * refused because only one display's pair was on screen at that moment: a
 * remembered pair does not need to be visible to be usable.
 *
 * A pair is dropped only when one of its ends no longer exists, which is the
 * cmux-restart and Chrome-restart case. A pair is never invented without an
 * observation.
 */
export function resolvePairs(
  stored: WindowPair[],
  liveCmuxWindows: readonly CmuxWindowId[],
  liveChromeWindows: readonly ChromeWindowId[],
  observation: PairObservation | null,
): PairResolution {
  const liveCmux = new Set(liveCmuxWindows);
  const liveChrome = new Set(liveChromeWindows);

  const kept = stored.filter((p) => liveCmux.has(p.cmuxWindowId) && liveChrome.has(p.chromeWindowId));
  let changed = kept.length !== stored.length;

  if (observation === null) return { pairs: kept, changed };
  if (!liveCmux.has(observation.cmuxWindowId) || !liveChrome.has(observation.chromeWindowId)) {
    return { pairs: kept, changed };
  }

  const already = kept.some(
    (p) => p.cmuxWindowId === observation.cmuxWindowId && p.chromeWindowId === observation.chromeWindowId,
  );
  if (already) return { pairs: kept, changed };

  // The pairing is one-to-one in both directions, so a new observation evicts
  // whatever either end was previously bound to. Without this a cmux window
  // could accumulate two Chrome windows and the desired path would be ambiguous.
  const pairs = kept.filter(
    (p) => p.cmuxWindowId !== observation.cmuxWindowId && p.chromeWindowId !== observation.chromeWindowId,
  );
  pairs.push({ cmuxWindowId: observation.cmuxWindowId, chromeWindowId: observation.chromeWindowId });
  changed = true;
  return { pairs, changed };
}
