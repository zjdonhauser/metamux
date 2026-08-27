// The ordered palette for colorMode: "palette" -- explicit {hex,
// chromeColor} pairs, NOT hue-mapped (hue-mapping in colors.ts is reserved
// for a USER-set cmux color, which always wins regardless of mode -- see
// registry.ts's resolveColor). Reads Zac's real brand hexes from
// ~/.config/cmux/cmux.json's workspaceColors.colors (name -> hex) via
// cmux-config.ts's existing reader; falls back to a hardcoded copy of that
// same table for any name the live file doesn't have (missing file,
// unparseable, or a name the user hasn't customized). Computed once at
// daemon startup (main.ts) and passed down -- a cmux.json edit takes
// effect on the next restart, same lifecycle as the named color slots.
//
// Ordering rationale:
// The first 9 entries use 9 DISTINCT Chrome tabGroups colors and 9
// visually distinct hexes, so every identity gets a genuinely different
// color for as long as possible before anything repeats. Entries 10+ reuse
// chromeColors (Chrome only has 9) but stay hex-distinct, so color
// backflow still paints a unique cmux tab color even once the visible
// Chrome group color repeats.
//
//  1. Blue     #2779FB -> blue    primary brand blue
//  2. Crimson  #E11D48 -> red     matches cmux's own notification red
//  3. Green    #047857 -> green   emerald
//  4. Amber    #D97706 -> yellow  warmest/most gold-leaning brand hex --
//                                 there's no true yellow in the table
//  5. Purple   #7C3AED -> purple  vivid violet
//  6. Magenta  #AD1457 -> pink    true magenta, more pink than Rose (#14)
//  7. Teal     #0E9F6E -> cyan    sits between green and blue -- the most
//                                 cyan-leaning hue left once Green/Blue
//                                 are already claimed above
//  8. Orange   #B45309 -> orange  brown-leaning orange, distinct from Amber
//  9. Navy     #152744 -> grey    near-black desaturated navy -- reads as
//                                 neutral/dark against the 8 vivid colors
//                                 above. This deliberately differs from
//                                 colors.ts's hue-mapping table (which maps
//                                 Navy to "blue"): an allocated color is an
//                                 explicit per-entry choice, not hue-
//                                 derived, by design -- see resolveColor's
//                                 ownership check for why this doesn't
//                                 fight with hue-mapping on repaint.
// 10. Indigo   #174897 -> blue    deep blue-violet, closest kin to #1
// 11. Aqua     #7DACFC -> cyan    light sky blue-cyan, distinct from Teal
// 12. Brown    #92400E -> orange  dark orange-brown
// 13. Red      #EF4444 -> red     bright red, distinct from Crimson
// 14. Rose     #9F1239 -> pink    dark rose, distinct from Magenta
// 15. Charcoal #5E6E7E -> grey    neutral grey-blue, distinct from Navy
// 16. Olive    #4A5C18 -> green   yellow-green, distinct from Green

import type { ChromeGroupColor } from "./colors.ts";
import { loadCmuxNamedColorSlots } from "./cmux-config.ts";

export interface PaletteEntry {
  name: string;
  hex: string;
  chromeColor: ChromeGroupColor;
}

/** Hardcoded fallback: Zac's live ~/.config/cmux/cmux.json
 * workspaceColors.colors table as of 2026-08-27. Used for any name the
 * live file is missing or unreadable -- see buildPalette. */
export const FALLBACK_HEXES: Record<string, string> = {
  Navy: "#152744",
  Blue: "#2779FB",
  Indigo: "#174897",
  Aqua: "#7DACFC",
  Teal: "#0E9F6E",
  Green: "#047857",
  Amber: "#D97706",
  Orange: "#B45309",
  Brown: "#92400E",
  Red: "#EF4444",
  Crimson: "#E11D48",
  Rose: "#9F1239",
  Purple: "#7C3AED",
  Charcoal: "#5E6E7E",
  Olive: "#4A5C18",
  Magenta: "#AD1457",
};

/** The distinguishability order -- see the file header comment. Only the
 * name + chromeColor are fixed here; the hex comes from whichever source
 * (live cmux.json or FALLBACK_HEXES) buildPalette resolves. */
export const PALETTE_ORDER: { name: string; chromeColor: ChromeGroupColor }[] = [
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

/** Builds the ordered palette: for each PALETTE_ORDER entry, the live hex
 * from `namedSlots` when present, else FALLBACK_HEXES -- so an
 * incomplete or missing cmux.json still yields the full, stably-ordered
 * palette rather than a shrunken one. Pure given its input; loadPalette
 * below is the I/O wrapper. */
export function buildPalette(namedSlots: Record<string, string> | null): PaletteEntry[] {
  const source = { ...FALLBACK_HEXES, ...(namedSlots ?? {}) };
  return PALETTE_ORDER.map((entry) => ({ name: entry.name, hex: source[entry.name]!, chromeColor: entry.chromeColor }));
}

/** I/O wrapper: reads ~/.config/cmux/cmux.json once (main.ts calls this at
 * startup, same lifecycle as loadCmuxNamedColorSlots for the existing
 * named-slot color resolution) and builds the ordered palette from it. */
export async function loadPalette(): Promise<PaletteEntry[]> {
  const namedSlots = await loadCmuxNamedColorSlots();
  return buildPalette(namedSlots);
}
