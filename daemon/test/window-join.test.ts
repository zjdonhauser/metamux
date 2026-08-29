import { describe, expect, test } from "bun:test";
import { joinWindows, type CGWindow, type ChromeWindow, type Display } from "../src/window-join.ts";

// Displays in CG coordinates (origin = PRIMARY screen's top-left, y grows down).
// Zac's real layout: 2560x1440 primary, with a 1920x1080 secondary ABOVE it.
// That "above" placement is what makes the coordinate flip a live trap.
const PRIMARY: Display = { id: 0, bounds: { x: 0, y: 0, w: 2560, h: 1440 } };
const SECONDARY: Display = { id: 1, bounds: { x: -1539, y: -1080, w: 1920, h: 1080 } };
const SCREENS = [PRIMARY, SECONDARY];

// Measured off the real machine while manually tiled (12px gap, mismatched y).
const TILED: CGWindow[] = [
  { id: 13349, owner: "cmux", bounds: { x: 0, y: 0, w: 1258, h: 1440 } },
  { id: 22934, owner: "Google Chrome", bounds: { x: 1270, y: 47, w: 1290, h: 1393 } },
];

// Split View shape: no gap, both full height, exactly halved.
const SPLIT: CGWindow[] = [
  { id: 900, owner: "cmux", bounds: { x: 0, y: 0, w: 1280, h: 1440 } },
  { id: 901, owner: "Google Chrome", bounds: { x: 1280, y: 0, w: 1280, h: 1440 } },
];

// The overlays and slivers the real window list is full of.
const NOISE: CGWindow[] = [
  { id: 24616, owner: "cmux", bounds: { x: 1258, y: 0, w: 13, h: 1440 } },
  { id: 19016, owner: "cmux", bounds: { x: 0, y: 0, w: 1258, h: 32 } },
  { id: 22937, owner: "Google Chrome", bounds: { x: 773, y: 0, w: 1290, h: 47 } },
];

describe("joinWindows", () => {
  test("pairs a manually tiled cmux and Chrome on one display", () => {
    const r = joinWindows(TILED, [], SCREENS);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ displayId: 0, cmuxWindowId: 13349, chromeCgWindowId: 22934 });
    expect(r.violations).toEqual([]);
  });

  test("pairs a Split View arrangement identically", () => {
    const r = joinWindows(SPLIT, [], SCREENS);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ cmuxWindowId: 900, chromeCgWindowId: 901 });
    expect(r.violations).toEqual([]);
  });

  test("filters out toolbars and slivers", () => {
    const r = joinWindows([...NOISE, ...TILED], [], SCREENS);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].cmuxWindowId).toBe(13349);
  });

  // The bug a first draft of the probe actually shipped: flipping with the union's
  // max Y instead of the primary's makes a full-height window match two displays.
  test("a full-height primary window never lands on the display above it", () => {
    const r = joinWindows(TILED, [], SCREENS);
    expect(r.pairs.every((p) => p.displayId === 0)).toBe(true);
    expect(r.pairs).toHaveLength(1);
  });

  test("assigns a window straddling two displays by its center", () => {
    const straddler: CGWindow[] = [
      { id: 1, owner: "cmux", bounds: { x: -600, y: -540, w: 1200, h: 1080 } },
      { id: 2, owner: "Google Chrome", bounds: { x: -1539, y: -1080, w: 900, h: 1080 } },
    ];
    const r = joinWindows(straddler, [], SCREENS);
    // Center of window 1 is (0, 0), which is inside the primary, not the secondary.
    expect(r.pairs).toHaveLength(0);
    expect(r.violations.some((v) => v.kind === "unpaired")).toBe(true);
  });

  test("refuses to guess when two Chrome windows share a display", () => {
    const ambiguous: CGWindow[] = [
      ...TILED,
      { id: 5555, owner: "Google Chrome", bounds: { x: 100, y: 100, w: 800, h: 600 } },
    ];
    const r = joinWindows(ambiguous, [], SCREENS);
    expect(r.pairs).toHaveLength(0);
    expect(r.violations).toContainEqual(
      expect.objectContaining({ kind: "ambiguous", displayId: 0, owner: "Google Chrome", count: 2 }),
    );
  });

  test("resolves the Chrome extension's own windowId by bounds", () => {
    const chrome: ChromeWindow[] = [
      { id: 42, bounds: { x: 1270, y: 47, w: 1290, h: 1393 } },
      { id: 99, bounds: { x: -1539, y: -1080, w: 1920, h: 1080 } },
    ];
    const r = joinWindows(TILED, chrome, SCREENS);
    expect(r.pairs[0].chromeWindowId).toBe(42);
  });

  test("tolerates small rounding differences in reported bounds", () => {
    const chrome: ChromeWindow[] = [{ id: 42, bounds: { x: 1271, y: 48, w: 1289, h: 1392 } }];
    const r = joinWindows(TILED, chrome, SCREENS);
    expect(r.pairs[0].chromeWindowId).toBe(42);
  });

  test("leaves chromeWindowId null when no reported bounds match", () => {
    const chrome: ChromeWindow[] = [{ id: 7, bounds: { x: 0, y: 0, w: 100, h: 100 } }];
    const r = joinWindows(TILED, chrome, SCREENS);
    expect(r.pairs[0].chromeWindowId).toBeNull();
  });

  test("an empty display produces neither a pair nor a violation", () => {
    const r = joinWindows(TILED, [], SCREENS);
    expect(r.violations.filter((v) => v.displayId === 1)).toEqual([]);
  });
});
