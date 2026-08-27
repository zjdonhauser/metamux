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

// A small fixed palette for tests -- entry 0 deliberately has a chromeColor
// ("grey") that DISAGREES with what colors.ts's hue-mapping would say for
// its own hex (nearestChromeGroupColor("#152744") is "blue"), exactly like
// palette.ts's real Navy entry -- this is what exercises the ownership-echo
// trap below.
const TEST_PALETTE: PaletteEntry[] = [
  { name: "Navy", hex: "#152744", chromeColor: "grey" },
  { name: "Blue", hex: "#2779FB", chromeColor: "blue" },
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
  test("targetHex is the allocated palette entry's own hex, not a Chrome-representative hex", () => {
    const refs = [ref({ id: "mw_a", title: "compliance", paletteIndex: 0 })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(candidates[0]!.identityColor).toBe("grey");
    expect(candidates[0]!.targetHex).toBe("#152744");
    // NOT the generic grey swatch backflow would use in hash mode:
    expect(candidates[0]!.targetHex).not.toBe(CHROME_GROUP_REPRESENTATIVE_HEX.grey);
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

  test(
    "the ownership-echo trap: painting an allocated hex whose chromeColor DISAGREES with hue-mapping must not " +
      "flip back on the next tick -- once cmuxColor === paintedColor, resolveColor skips hue-mapping entirely",
    () => {
      // Round 1: nothing painted yet -- backflow should want to paint Navy's
      // allocated hex (#152744, chromeColor "grey").
      const before = ref({ id: "mw_a", title: "compliance", paletteIndex: 0, cmuxColor: null, paintedColor: null });
      const candidatesBefore = computeBackflowCandidates([before], "title", "palette", TEST_PALETTE);
      const decisionBefore = decideBackflow({
        hasRealColor: candidatesBefore[0]!.hasRealColor,
        targetHex: candidatesBefore[0]!.targetHex,
        ref: { cmuxColor: before.cmuxColor, paintedColor: before.paintedColor },
      });
      expect(decisionBefore).toEqual({ action: "paint", targetHex: "#152744" });
      expect(nearestChromeGroupColor("#152744")).toBe("blue"); // confirms the hue-mapping trap is real

      // Round 2: the paint round-tripped through the tailed `colored` event
      // (cmuxColor = "#152744") and markPainted recorded the same hex --
      // ownership established. The group's resolved color must STAY grey
      // (the allocated chromeColor), not flip to blue via hue-mapping, and
      // backflow must now skip it as already-matching.
      const after = ref({ id: "mw_a", title: "compliance", paletteIndex: 0, cmuxColor: "#152744", paintedColor: "#152744" });
      const candidatesAfter = computeBackflowCandidates([after], "title", "palette", TEST_PALETTE);
      expect(candidatesAfter[0]!.identityColor).toBe("grey");
      expect(candidatesAfter[0]!.hasRealColor).toBe(false); // still ours, not the user's
      const decisionAfter = decideBackflow({
        hasRealColor: candidatesAfter[0]!.hasRealColor,
        targetHex: candidatesAfter[0]!.targetHex,
        ref: { cmuxColor: after.cmuxColor, paintedColor: after.paintedColor },
      });
      expect(decisionAfter).toEqual({ action: "skip", reason: "already-matches" });
    },
  );
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

  test("end to end: colorMode palette paints the allocated brand hex", () => {
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", paletteIndex: 0 })];
    const candidates = computeBackflowCandidates(refs, "title", "palette", TEST_PALETTE);
    expect(planBackflow(candidates)).toEqual([{ refId: "mw_a", cmuxWorkspaceId: "cmux-a", targetHex: "#152744" }]);
  });
});
