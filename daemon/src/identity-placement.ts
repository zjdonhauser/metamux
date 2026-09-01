import type { PairObservation } from "./model/window-pairs.ts";

/**
 * Bridges the CG-geometry join's numeric Chrome window id to the identity
 * model's minted one.
 *
 * The join (window-pairing.ts) already answers "which Chrome window (as
 * chrome.windows.id) pairs with this cmux window", live and continuously.
 * What it cannot know is the minted id, since that only exists as a marker
 * tab the extension reports. `numericToMinted` is that extension-reported
 * map, refreshed on every observation frame. A miss here (no marker yet, or
 * the marker fell out of the observation) yields null rather than a guess.
 */
export function resolvePairObservation(
  cmuxWindowId: string | null,
  chromeNumericWindowId: number | null,
  numericToMinted: ReadonlyMap<number, string>,
): PairObservation | null {
  if (cmuxWindowId === null || chromeNumericWindowId === null) return null;
  const chromeWindowId = numericToMinted.get(chromeNumericWindowId);
  return chromeWindowId === undefined ? null : { cmuxWindowId, chromeWindowId };
}
