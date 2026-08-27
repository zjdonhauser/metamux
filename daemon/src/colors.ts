// Pure color mapping: a cmux workspace color (a "#RRGGBB" hex, or a named
// cmux.json workspaceColors slot like "Blue") mapped to the nearest of
// Chrome's 9 tabGroups colors, HUE-FIRST. No I/O -- the named-slot table,
// when available, is read once at startup from ~/.config/cmux/cmux.json
// (main.ts) and passed in.
//
// Hue-first, not RGB Euclidean distance: humans classify color by hue. A
// dark, desaturated navy IS blue to a person even though its raw RGB
// values sit numerically closer to a dark green or grey swatch -- see the
// build report for the discrepancy this replaced.

export const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type ChromeGroupColor = (typeof TAB_GROUP_COLORS)[number];

// Deterministic tie-break order: the first chromatic color (in this order)
// at the minimum circular hue distance wins.
const CHROMATIC_ORDER: Exclude<ChromeGroupColor, "grey">[] = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

// Representative hex for each chromatic Chrome tabGroups color (grey is
// decided by saturation/lightness thresholds, not hue distance -- it has
// no meaningful hue).
const CHROMATIC_REPRESENTATIVE_HEX: Record<Exclude<ChromeGroupColor, "grey">, string> = {
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#a142f4",
  cyan: "#007b83",
  orange: "#fa903e",
};

interface Hsl {
  h: number; // 0-360
  s: number; // 0-1
  l: number; // 0-1
}

function parseHexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function hexToHsl(hex: string): Hsl | null {
  const rgb = parseHexToRgb(hex);
  if (!rgb) return null;

  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  h *= 60;

  return { h, s, l };
}

const SWATCH_HUES: Record<Exclude<ChromeGroupColor, "grey">, number> = Object.fromEntries(
  CHROMATIC_ORDER.map((name) => [name, hexToHsl(CHROMATIC_REPRESENTATIVE_HEX[name])!.h]),
) as Record<Exclude<ChromeGroupColor, "grey">, number>;

function circularHueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** Hue-first nearest of Chrome's 9 tabGroups colors to an arbitrary hex.
 * Low saturation or extreme lightness -> "grey" (no meaningful hue);
 * otherwise the chromatic swatch with the smallest circular hue distance,
 * ties broken by CHROMATIC_ORDER. null if the hex string doesn't parse. */
export function nearestChromeGroupColor(hex: string): ChromeGroupColor | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;

  if (hsl.s < 0.15 || hsl.l > 0.92 || hsl.l < 0.05) return "grey";

  let best: Exclude<ChromeGroupColor, "grey"> = CHROMATIC_ORDER[0];
  let bestDist = Infinity;
  for (const name of CHROMATIC_ORDER) {
    const dist = circularHueDistance(hsl.h, SWATCH_HUES[name]);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/** Resolves a raw cmux workspace color to a final hex string: a "#..."
 * value passes through unchanged; a named slot (e.g. "Blue") is looked up
 * in the cmux.json workspaceColors.colors table. null for clear_color's
 * null, an unknown slot name, or a slot name with no table available. */
export function resolveCmuxColor(raw: string | null, namedSlots: Record<string, string> | null): string | null {
  if (raw === null) return null;
  if (raw.startsWith("#")) return raw;
  return namedSlots?.[raw] ?? null;
}
