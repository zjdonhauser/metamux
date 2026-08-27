import { describe, expect, test } from "bun:test";
import { CHROME_GROUP_REPRESENTATIVE_HEX, nearestChromeGroupColor, resolveCmuxColor, TAB_GROUP_COLORS } from "../src/colors.ts";

describe("nearestChromeGroupColor -- hue-first mapping", () => {
  test("cmux.json's real 'Navy' slot (#152744) maps to blue (hue 217.0 vs swatch blue 214.1, dist 2.9)", () => {
    expect(nearestChromeGroupColor("#152744")).toBe("blue");
  });

  test("SafeLease brand blue #2779FB maps to blue (real value from live cmux data, 166 occurrences)", () => {
    expect(nearestChromeGroupColor("#2779FB")).toBe("blue");
  });

  test("other navy readings also map to blue: cmux.json's commented-template Navy (#1A5276)", () => {
    expect(nearestChromeGroupColor("#1A5276")).toBe("blue");
  });

  test("other navy readings also map to blue: common web navy (#001F3F)", () => {
    expect(nearestChromeGroupColor("#001F3F")).toBe("blue");
  });

  test("#E11D48 (cmux.json's Crimson/notificationBadgeColor) maps to red (hue 346.8 vs swatch red 3.7, dist 16.9; vs pink 324.8, dist 22.0)", () => {
    expect(nearestChromeGroupColor("#E11D48")).toBe("red");
  });

  test("#808080 (zero saturation, textbook grey) maps to grey", () => {
    expect(nearestChromeGroupColor("#808080")).toBe("grey");
  });

  test("#FAF8F3 (warm paper, very light -- lightness 0.967 > 0.92 threshold) maps to grey", () => {
    expect(nearestChromeGroupColor("#FAF8F3")).toBe("grey");
  });

  test("cmux.json's 'Amber' slot (#D97706) maps to orange (hue 32.1 vs swatch orange 26.2, dist 5.9; vs yellow 41.2, dist 9.1)", () => {
    expect(nearestChromeGroupColor("#D97706")).toBe("orange");
  });

  test("the green swatch's own representative hex maps to itself", () => {
    expect(nearestChromeGroupColor("#188038")).toBe("green");
  });

  test("is deterministic for the same hex", () => {
    expect(nearestChromeGroupColor("#188038")).toBe(nearestChromeGroupColor("#188038"));
  });

  test("the exact representative hex for each chromatic color maps to itself", () => {
    const representatives: Record<Exclude<(typeof TAB_GROUP_COLORS)[number], "grey">, string> = {
      blue: "#1a73e8",
      red: "#d93025",
      yellow: "#f9ab00",
      green: "#188038",
      pink: "#d01884",
      purple: "#a142f4",
      cyan: "#007b83",
      orange: "#fa903e",
    };
    for (const name of Object.keys(representatives) as (keyof typeof representatives)[]) {
      expect(nearestChromeGroupColor(representatives[name])).toBe(name);
    }
  });

  test("CHROME_GROUP_REPRESENTATIVE_HEX is a fixed point for every one of the 9 colors -- color backflow's loop-safety proof", () => {
    // If a backflow-painted hex didn't map back to the SAME Chrome color,
    // the daemon's own color pipeline (colored event -> cmuxColor ->
    // colorFor) would compute a DIFFERENT group color than what was
    // painted, triggering another backflow paint next tick -- a repaint
    // loop. This is the guarantee that can't happen.
    for (const name of TAB_GROUP_COLORS) {
      expect(nearestChromeGroupColor(CHROME_GROUP_REPRESENTATIVE_HEX[name])).toBe(name);
    }
  });

  test("only ever returns one of the 9 Chrome tabGroups colors", () => {
    for (const hex of ["#000000", "#ffffff", "#123456", "#abcdef", "#152744", "#E11D48"]) {
      expect(TAB_GROUP_COLORS).toContain(nearestChromeGroupColor(hex)!);
    }
  });

  test("is case-insensitive and tolerates a missing leading #", () => {
    expect(nearestChromeGroupColor("2779FB")).toBe(nearestChromeGroupColor("#2779FB"));
    expect(nearestChromeGroupColor("#2779fb")).toBe(nearestChromeGroupColor("#2779FB"));
  });

  test("returns null for an unparseable hex", () => {
    expect(nearestChromeGroupColor("not-a-color")).toBeNull();
    expect(nearestChromeGroupColor("#12")).toBeNull();
    expect(nearestChromeGroupColor("")).toBeNull();
  });
});

describe("nearestChromeGroupColor -- real cmux.json named-slot hexes (computed, not assumed)", () => {
  // Every one of these is the literal hex from ~/.config/cmux/cmux.json's
  // active workspaceColors.colors table. Two land somewhere other than
  // what a human might guess from the slot's NAME -- see the build report
  // for why (hue-nearest against these 9 swatches, computed with Python,
  // not tuned to match the slot name).

  test("'Teal' (#0E9F6E) maps to green (hue 159.7 -- 21.2 from green's 138.5, 24.0 from cyan's 183.7)", () => {
    expect(nearestChromeGroupColor("#0E9F6E")).toBe("green");
  });

  test("'Aqua' (#7DACFC) maps to blue (hue 217.8 -- 3.7 from blue's 214.1, 34.1 from cyan's 183.7)", () => {
    expect(nearestChromeGroupColor("#7DACFC")).toBe("blue");
  });

  test("'Green' (#047857) maps to cyan (hue 162.9 -- 20.8 from cyan's 183.7, 24.4 from green's 138.5)", () => {
    expect(nearestChromeGroupColor("#047857")).toBe("cyan");
  });

  test("'Indigo' (#174897) maps to blue", () => {
    expect(nearestChromeGroupColor("#174897")).toBe("blue");
  });

  test("'Orange' (#B45309) maps to orange", () => {
    expect(nearestChromeGroupColor("#B45309")).toBe("orange");
  });

  test("'Brown' (#92400E) maps to orange", () => {
    expect(nearestChromeGroupColor("#92400E")).toBe("orange");
  });

  test("'Purple' (#7C3AED) maps to purple", () => {
    expect(nearestChromeGroupColor("#7C3AED")).toBe("purple");
  });

  test("'Rose' (#9F1239) maps to pink", () => {
    expect(nearestChromeGroupColor("#9F1239")).toBe("pink");
  });

  test("'Charcoal' (#5E6E7E) maps to grey (low saturation, 0.145 < 0.15 threshold)", () => {
    expect(nearestChromeGroupColor("#5E6E7E")).toBe("grey");
  });

  test("'Magenta' (#AD1457) maps to pink", () => {
    expect(nearestChromeGroupColor("#AD1457")).toBe("pink");
  });

  test("'Red' (#EF4444) maps to red", () => {
    expect(nearestChromeGroupColor("#EF4444")).toBe("red");
  });
});

describe("resolveCmuxColor", () => {
  const namedSlots = {
    Navy: "#152744",
    Blue: "#2779FB",
    Indigo: "#174897",
    Crimson: "#E11D48",
  };

  test("a hex value passes through unchanged", () => {
    expect(resolveCmuxColor("#2779FB", namedSlots)).toBe("#2779FB");
  });

  test("a named slot resolves to its hex via the table", () => {
    expect(resolveCmuxColor("Blue", namedSlots)).toBe("#2779FB");
    expect(resolveCmuxColor("Navy", namedSlots)).toBe("#152744");
  });

  test("null (clear_color) resolves to null", () => {
    expect(resolveCmuxColor(null, namedSlots)).toBeNull();
  });

  test("an unknown named slot resolves to null when no table entry matches", () => {
    expect(resolveCmuxColor("SomeUnknownSlot", namedSlots)).toBeNull();
  });

  test("a named slot with no table available (null) resolves to null", () => {
    expect(resolveCmuxColor("Blue", null)).toBeNull();
  });

  test("a hex value passes through even with no table available", () => {
    expect(resolveCmuxColor("#2779FB", null)).toBe("#2779FB");
  });
});
