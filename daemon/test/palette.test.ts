import { describe, expect, test } from "bun:test";
import { buildPalette, loadPalette, PALETTE_ORDER } from "../src/palette.ts";
import { TAB_GROUP_COLORS } from "../src/colors.ts";

describe("buildPalette", () => {
  test("returns every PALETTE_ORDER entry, in order", () => {
    const palette = buildPalette();
    expect(palette.length).toBe(PALETTE_ORDER.length);
    for (const [i, entry] of palette.entries()) {
      expect(entry.name).toBe(PALETTE_ORDER[i]!.name);
      expect(entry.chromeColor).toBe(PALETTE_ORDER[i]!.chromeColor);
    }
  });

  test("first 9 entries use 9 DISTINCT Chrome tabGroups colors", () => {
    const palette = buildPalette();
    const first9 = palette.slice(0, 9).map((e) => e.chromeColor);
    expect(new Set(first9).size).toBe(9);
    for (const c of first9) expect(TAB_GROUP_COLORS).toContain(c);
  });

  test("all 16 entries have distinct names", () => {
    const palette = buildPalette();
    const names = palette.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every entry's chromeColor is one of the 9 Chrome tabGroups colors", () => {
    const palette = buildPalette();
    for (const entry of palette) expect(TAB_GROUP_COLORS).toContain(entry.chromeColor);
  });

  test("returns a fresh array each call -- mutating one result never affects another", () => {
    const a = buildPalette();
    const b = buildPalette();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a[0]!.name = "mutated";
    expect(b[0]!.name).not.toBe("mutated");
  });
});

describe("loadPalette", () => {
  test("resolves to the same palette as buildPalette (no I/O left to vary the result)", async () => {
    const palette = await loadPalette();
    expect(palette).toEqual(buildPalette());
  });
});
