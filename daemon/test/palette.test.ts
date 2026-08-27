import { describe, expect, test } from "bun:test";
import { buildPalette, FALLBACK_HEXES, loadPalette, PALETTE_ORDER } from "../src/palette.ts";
import { TAB_GROUP_COLORS } from "../src/colors.ts";

describe("buildPalette", () => {
  test("with a null table (unreadable cmux.json), returns the hardcoded fallback hexes in order", () => {
    const palette = buildPalette(null);
    expect(palette.length).toBe(PALETTE_ORDER.length);
    for (const [i, entry] of palette.entries()) {
      expect(entry.name).toBe(PALETTE_ORDER[i]!.name);
      expect(entry.chromeColor).toBe(PALETTE_ORDER[i]!.chromeColor);
      expect(entry.hex).toBe(FALLBACK_HEXES[PALETTE_ORDER[i]!.name]);
    }
  });

  test("with an empty table, also falls back to the hardcoded hexes", () => {
    const palette = buildPalette({});
    expect(palette[0]!.hex).toBe(FALLBACK_HEXES["Blue"]);
  });

  test("live cmux.json hexes override the fallback for names present in the table", () => {
    const palette = buildPalette({ Blue: "#000001" });
    const blueEntry = palette.find((e) => e.name === "Blue")!;
    expect(blueEntry.hex).toBe("#000001");
    // every other entry still falls back since only Blue was overridden
    const navyEntry = palette.find((e) => e.name === "Navy")!;
    expect(navyEntry.hex).toBe(FALLBACK_HEXES["Navy"]);
  });

  test("first 9 entries use 9 DISTINCT Chrome tabGroups colors", () => {
    const palette = buildPalette(null);
    const first9 = palette.slice(0, 9).map((e) => e.chromeColor);
    expect(new Set(first9).size).toBe(9);
    for (const c of first9) expect(TAB_GROUP_COLORS).toContain(c);
  });

  test("all 16 entries have distinct hexes", () => {
    const palette = buildPalette(null);
    const hexes = palette.map((e) => e.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  test("every entry's chromeColor is one of the 9 Chrome tabGroups colors", () => {
    const palette = buildPalette(null);
    for (const entry of palette) expect(TAB_GROUP_COLORS).toContain(entry.chromeColor);
  });

  test("ordering is deterministic across calls", () => {
    expect(buildPalette(null)).toEqual(buildPalette(null));
  });
});

describe("loadPalette", () => {
  test("resolves without throwing regardless of whether ~/.config/cmux/cmux.json exists", async () => {
    const palette = await loadPalette();
    expect(palette.length).toBe(PALETTE_ORDER.length);
  });
});
