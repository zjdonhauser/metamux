import { describe, expect, test } from "bun:test";
import { CHROME_GROUP_REPRESENTATIVE_HEX, nearestChromeGroupColor } from "../src/colors.ts";
import { colorFor } from "../src/registry.ts";
import type { PaletteEntry } from "../src/palette.ts";
import {
  computeBackflowCandidates,
  decideBackflow,
  planBackflow,
  type BackflowRef,
} from "../src/color-backflow.ts";

function ref(overrides: Partial<BackflowRef> = {}): BackflowRef {
  return {
    id: "mw_a",
    source: "cmux",
    sourceId: "cmux-uuid-a",
    title: "compliance",
    cmuxColor: null,
    paintedColor: null,
    paletteIndex: null,
    archived: false,
    ...overrides,
  };
}

// A small fixed palette for tests. No hex field (2026-08-27) -- backflow
// paints CHROME_GROUP_REPRESENTATIVE_HEX for the resolved chromeColor now,
// never a palette entry's own hex (palette.ts no longer even has one).
const TEST_PALETTE: PaletteEntry[] = [
  { name: "Navy", chromeColor: "grey" },
  { name: "Blue", chromeColor: "blue" },
];

describe("decideBackflow -- the paint/skip/repaint matrix", () => {
  const targetHex = CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)];

  test("a real (user-set) color on the identity is never touched -- skip: no-fallback-color", () => {
    const out = decideBackflow({ hasRealColor: true, targetHex, ref: { cmuxColor: null, paintedColor: null } });
    expect(out).toEqual({ action: "skip", reason: "no-fallback-color" });
  });

  test("never touched (null/null) under a fallback color -- paint", () => {
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: null, paintedColor: null } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("already matches our target -- skip: already-matches (dedupe)", () => {
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: targetHex, paintedColor: targetHex } });
    expect(out).toEqual({ action: "skip", reason: "already-matches" });
  });

  test("carries a stale paint of ours (target changed since) -- paint the new target", () => {
    const staleHex = "#000000";
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: staleHex, paintedColor: staleHex } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("user cleared a color we'd painted (cmuxColor null, paintedColor set) -- repaint", () => {
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: null, paintedColor: "#123456" } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("user set a real color we never painted -- skip: user-owned, never touch it", () => {
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: "#654321", paintedColor: null } });
    expect(out).toEqual({ action: "skip", reason: "user-owned" });
  });

  test("user overwrote our paint with a different color -- skip: user-owned, theirs wins", () => {
    const out = decideBackflow({ hasRealColor: false, targetHex, ref: { cmuxColor: "#654321", paintedColor: "#123456" } });
    expect(out).toEqual({ action: "skip", reason: "user-owned" });
  });
});

describe("computeBackflowCandidates -- colorMode: hash (unchanged behavior)", () => {
  test("groupBy: workspace -- each ref is its own group, identity color from its own cmuxColor or title hash", () => {
    const refs = [ref({ id: "mw_a", title: "aaa", cmuxColor: null }), ref({ id: "mw_b", title: "bbb", cmuxColor: "#2779FB" })];
    const candidates = computeBackflowCandidates(refs, "workspace", "hash", []);
    expect(candidates).toHaveLength(2);
    const a = candidates.find((c) => c.refId === "mw_a")!;
    const b = candidates.find((c) => c.refId === "mw_b")!;
    expect(a.hasRealColor).toBe(false);
    expect(a.identityColor).toBe(colorFor("aaa", null));
    expect(a.targetHex).toBe(CHROME_GROUP_REPRESENTATIVE_HEX[a.identityColor]);
    expect(b.hasRealColor).toBe(true);
    expect(b.identityColor).toBe(colorFor("bbb", "#2779FB"));
  });

  test("groupBy: title -- same-title refs share one identity color, real color wins if any member has one", () => {
    const refs = [
      ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: null }),
      ref({ id: "mw_b", sourceId: "cmux-b", title: "compliance", cmuxColor: "#2779FB" }),
    ];
    const candidates = computeBackflowCandidates(refs, "title", "hash", []);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.hasRealColor).toBe(true);
      expect(c.identityColor).toBe(colorFor("compliance", "#2779FB"));
    }
  });

  test("archived refs are excluded entirely", () => {
    const refs = [ref({ id: "mw_a", archived: true })];
    expect(computeBackflowCandidates(refs, "workspace", "hash", [])).toEqual([]);
  });

  test("tmux-sourced refs never produce a candidate (nothing to cmux-actuator paint)", () => {
    const refs = [ref({ id: "mw_a", source: "cmux" }), ref({ id: "mw_b", source: "tmux", sourceId: "$1" })];
    const candidates = computeBackflowCandidates(refs, "workspace", "hash", []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.refId).toBe("mw_a");
  });
});

describe("computeBackflowCandidates -- colorMode: palette", () => {
  test("targetHex is the Chrome-representative hex for the allocated entry's chromeColor, never a brand hex (2026-08-27)", () => {
    const refs = [ref({ id: "mw_a", title: "compliance", paletteIndex: 0 })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(candidates[0]!.identityColor).toBe("grey"); // TEST_PALETTE[0] = Navy, chromeColor "grey"
    expect(candidates[0]!.targetHex).toBe(CHROME_GROUP_REPRESENTATIVE_HEX.grey);
  });

  test("colorMode: hash and colorMode: palette paint the IDENTICAL hex for the same resolved chromeColor", () => {
    // The whole point of this change: the two modes only ever differed in
    // which chromeColor an identity resolves to, never in what hex gets
    // painted for a given chromeColor. Pick a hash-mode title guaranteed to
    // resolve to "grey" (TEST_PALETTE[0]'s chromeColor) by computing it,
    // rather than guessing a title whose hash happens to land there.
    let hashTitle = "x";
    while (colorFor(hashTitle, null) !== "grey") hashTitle += "x";

    const hashCandidate = computeBackflowCandidates([ref({ id: "mw_hash", title: hashTitle })], "title", "hash", [])[0]!;
    const paletteCandidate = computeBackflowCandidates(
      [ref({ id: "mw_palette", title: "compliance", paletteIndex: 0 })],
      "title",
      "palette",
      TEST_PALETTE,
    )[0]!;
    expect(hashCandidate.identityColor).toBe("grey");
    expect(paletteCandidate.identityColor).toBe("grey");
    expect(hashCandidate.targetHex).toBe(paletteCandidate.targetHex); // same swatch hex
    expect(hashCandidate.targetHex).toBe(CHROME_GROUP_REPRESENTATIVE_HEX.grey);
  });

  test("no claim yet (paletteIndex null) falls back to the Chrome-representative hex for the title hash", () => {
    const refs = [ref({ id: "mw_a", title: "compliance", paletteIndex: null })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(candidates[0]!.targetHex).toBe(CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)]);
  });

  test("a real user color still wins over an allocated palette entry", () => {
    const refs = [ref({ id: "mw_a", title: "compliance", paletteIndex: 0, cmuxColor: "#2779FB", paintedColor: null })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(candidates[0]!.hasRealColor).toBe(true);
    expect(candidates[0]!.identityColor).toBe("blue"); // hue-mapped from the user's #2779FB
  });

  test("painting the swatch hex converges cleanly: it hue-maps back to the exact allocated chromeColor, no ownership trap possible", () => {
    // Round 1: nothing painted yet -- backflow wants to paint Navy's
    // resolved chromeColor's swatch hex (grey's representative, not
    // Navy's own brand hex -- there is no brand hex anymore).
    const before = ref({ id: "mw_a", title: "compliance", paletteIndex: 0, cmuxColor: null, paintedColor: null });
    const candidatesBefore = computeBackflowCandidates([before], "title", "palette", TEST_PALETTE);
    const targetHex = candidatesBefore[0]!.targetHex;
    expect(targetHex).toBe(CHROME_GROUP_REPRESENTATIVE_HEX.grey);
    const decisionBefore = decideBackflow({
      hasRealColor: candidatesBefore[0]!.hasRealColor,
      targetHex,
      ref: { cmuxColor: before.cmuxColor, paintedColor: before.paintedColor },
    });
    expect(decisionBefore).toEqual({ action: "paint", targetHex });
    // Unlike the old brand-hex design, the swatch hex is a PROVEN fixed
    // point (colors.test.ts) -- painting it can never disagree with the
    // chromeColor that produced it, so there's no trap left to guard here.
    expect(nearestChromeGroupColor(targetHex)).toBe("grey");

    // Round 2: the paint round-tripped through the tailed `colored` event
    // and markPainted recorded the same hex -- ownership established,
    // resolved color stays grey, backflow now skips as already-matching.
    const after = ref({ id: "mw_a", title: "compliance", paletteIndex: 0, cmuxColor: targetHex, paintedColor: targetHex });
    const candidatesAfter = computeBackflowCandidates([after], "title", "palette", TEST_PALETTE);
    expect(candidatesAfter[0]!.identityColor).toBe("grey");
    expect(candidatesAfter[0]!.hasRealColor).toBe(false); // still ours, not the user's
    const decisionAfter = decideBackflow({
      hasRealColor: candidatesAfter[0]!.hasRealColor,
      targetHex: candidatesAfter[0]!.targetHex,
      ref: { cmuxColor: after.cmuxColor, paintedColor: after.paintedColor },
    });
    expect(decisionAfter).toEqual({ action: "skip", reason: "already-matches" });
  });
});

describe("repaint convergence: a tab painted before this change (a real brand hex) repaints to the swatch hex", () => {
  // Simulates exactly what every already-painted live tab looks like right
  // after this daemon build ships: cmuxColor/paintedColor both still hold
  // the OLD brand hex (it round-tripped through the tailed `colored` event
  // before the restart, so it's not "user-owned" -- cmuxColor ===
  // paintedColor), but the identity's target is now the swatch hex.
  const OLD_BRAND_HEX = "#152744"; // palette.ts's old Navy entry, now gone
  const swatchHex = CHROME_GROUP_REPRESENTATIVE_HEX.grey;

  test("decideBackflow treats it as a repaint, not user-owned and not already-matching", () => {
    const decision = decideBackflow({
      hasRealColor: false,
      targetHex: swatchHex,
      ref: { cmuxColor: OLD_BRAND_HEX, paintedColor: OLD_BRAND_HEX },
    });
    expect(decision).toEqual({ action: "paint", targetHex: swatchHex });
  });

  test("end to end through computeBackflowCandidates + planBackflow: colorMode palette", () => {
    const refs = [
      ref({
        id: "mw_a",
        sourceId: "cmux-a",
        title: "compliance",
        paletteIndex: 0,
        cmuxColor: OLD_BRAND_HEX,
        paintedColor: OLD_BRAND_HEX,
      }),
    ];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(candidates[0]!.hasRealColor).toBe(false); // still recognized as ours, not the user's
    expect(planBackflow(candidates)).toEqual([{ refId: "mw_a", cmuxWorkspaceId: "cmux-a", targetHex: swatchHex }]);
  });

  test("end to end through computeBackflowCandidates + planBackflow: colorMode hash", () => {
    // Same shape can happen in hash mode too if a prior daemon build ever
    // painted a non-swatch hex for any reason -- the convergence isn't
    // palette-specific.
    const refs = [
      ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: OLD_BRAND_HEX, paintedColor: OLD_BRAND_HEX }),
    ];
    const candidates = computeBackflowCandidates(refs, "title", "hash", []);
    const target = CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)];
    expect(planBackflow(candidates)).toEqual([{ refId: "mw_a", cmuxWorkspaceId: "cmux-a", targetHex: target }]);
  });

  test("once repainted to the swatch hex, the NEXT tick sees already-matches -- convergence is stable, not a loop", () => {
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", paletteIndex: 0, cmuxColor: swatchHex, paintedColor: swatchHex })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(planBackflow(candidates)).toEqual([]);
  });
});

describe("planBackflow", () => {
  test("end to end: a fresh title-hash-colored ref gets one paint action", () => {
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance" })];
    const candidates = computeBackflowCandidates(refs, "title", "hash", []);
    const actions = planBackflow(candidates);
    expect(actions).toEqual([
      { refId: "mw_a", cmuxWorkspaceId: "cmux-a", targetHex: CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)] },
    ]);
  });

  test("end to end: a user-colored identity produces zero actions for any member", () => {
    const refs = [
      ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: "#2779FB" }),
      ref({ id: "mw_b", sourceId: "cmux-b", title: "compliance", cmuxColor: null }),
    ];
    const candidates = computeBackflowCandidates(refs, "title", "hash", []);
    expect(planBackflow(candidates)).toEqual([]);
  });

  test("end to end: an already-matching ref produces zero actions (no redundant set-color calls)", () => {
    const target = CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)];
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: target, paintedColor: target })];
    const candidates = computeBackflowCandidates(refs, "title", "hash", []);
    expect(planBackflow(candidates)).toEqual([]);
  });

  test("end to end: colorMode palette paints the Chrome-representative swatch hex for the allocated chromeColor", () => {
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", paletteIndex: 0 })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(planBackflow(candidates)).toEqual([
      { refId: "mw_a", cmuxWorkspaceId: "cmux-a", targetHex: CHROME_GROUP_REPRESENTATIVE_HEX.grey },
    ]);
  });
});
