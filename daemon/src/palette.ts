// The ordered palette for colorMode: "palette" -- an ordered, distinct
// list of Chrome tabGroups colors an identity can be allocated
// (palette-allocator.ts's job; see that file for the claim algorithm).
//
// Hex plumbing removed (2026-08-27, Zac feedback on the live system): this
// used to carry a {hex, chromeColor} pair per entry, and color-backflow.ts
// painted the entry's own brand hex onto the cmux tab. That visibly didn't
// match Chrome's own rendering of the same chromeColor -- Chrome renders
// its 9 tabGroups colors from its own internal swatches, not from any hex
// metamux supplies, so a distinct brand hex sharing a color NAME with a
// Chrome swatch still looked like a different color next to it. Backflow
// now always paints colors.ts's CHROME_GROUP_REPRESENTATIVE_HEX for
// whatever chromeColor the identity resolves to (both colorMode: "hash"
// and "palette"), so the per-entry hex here was dead weight -- dropped
// cleanly rather than left unused. What's left, and all that was ever
// load-bearing for allocation itself, is the ORDERING: first 9 entries
// use 9 DISTINCT Chrome tabGroups colors, so every identity gets a
// genuinely different color for as long as possible before anything
// repeats; entries 10+ necessarily reuse colors (Chrome only has 9).
//
//  1. Blue     -> blue
//  2. Crimson  -> red
//  3. Green    -> green
//  4. Amber    -> yellow
//  5. Purple   -> purple
//  6. Magenta  -> pink
//  7. Teal     -> cyan
//  8. Orange   -> orange
//  9. Navy     -> grey
// 10. Indigo   -> blue
// 11. Aqua     -> cyan
// 12. Brown    -> orange
// 13. Red      -> red
// 14. Rose     -> pink
// 15. Charcoal -> grey
// 16. Olive    -> green

import type { ChromeGroupColor } from "./colors.ts";

export interface PaletteEntry {
  name: string;
  chromeColor: ChromeGroupColor;
}

/** The distinguishability order -- see the file header comment. This IS
 * the palette; nothing further needs building from external state now
 * that hex resolution is gone. */
export const PALETTE_ORDER: PaletteEntry[] = [
  { name: "Blue", chromeColor: "blue" },
  { name: "Crimson", chromeColor: "red" },
  { name: "Green", chromeColor: "green" },
  { name: "Amber", chromeColor: "yellow" },
  { name: "Purple", chromeColor: "purple" },
  { name: "Magenta", chromeColor: "pink" },
  { name: "Teal", chromeColor: "cyan" },
  { name: "Orange", chromeColor: "orange" },
  { name: "Navy", chromeColor: "grey" },
  { name: "Indigo", chromeColor: "blue" },
  { name: "Aqua", chromeColor: "cyan" },
  { name: "Brown", chromeColor: "orange" },
  { name: "Red", chromeColor: "red" },
  { name: "Rose", chromeColor: "pink" },
  { name: "Charcoal", chromeColor: "grey" },
  { name: "Olive", chromeColor: "green" },
];

/** A fresh copy of PALETTE_ORDER. Pure, deterministic, no input -- kept as
 * a named function (rather than exporting PALETTE_ORDER directly to every
 * call site) so callers read "the built palette" as a concept, matching
 * loadPalette's shape, and so a future allocation-order change has one
 * place to land without touching every caller's import. */
export function buildPalette(): PaletteEntry[] {
  return PALETTE_ORDER.map((entry) => ({ ...entry }));
}

/** I/O-shaped wrapper kept async solely so existing `await loadPalette()`
 * call sites (main.ts) don't need to change -- there's no actual I/O left
 * now that hex resolution (and the cmux.json read it required) is gone. */
export async function loadPalette(): Promise<PaletteEntry[]> {
  return buildPalette();
}
