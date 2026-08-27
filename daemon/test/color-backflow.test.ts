import { describe, expect, test } from "bun:test";
import { CHROME_GROUP_REPRESENTATIVE_HEX } from "../src/colors.ts";
import { colorFor } from "../src/registry.ts";
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
    archived: false,
    ...overrides,
  };
}

describe("decideBackflow -- the paint/skip/repaint matrix", () => {
  const identityColor = colorFor("compliance", null); // whatever the title-hash fallback resolves to
  const targetHex = CHROME_GROUP_REPRESENTATIVE_HEX[identityColor];

  test("a real (user-set) color on the identity is never touched -- skip: no-fallback-color", () => {
    const out = decideBackflow({
      identityColor: "blue",
      hasRealColor: true,
      ref: { cmuxColor: null, paintedColor: null },
    });
    expect(out).toEqual({ action: "skip", reason: "no-fallback-color" });
  });

  test("never touched (null/null) under a fallback color -- paint", () => {
    const out = decideBackflow({ identityColor, hasRealColor: false, ref: { cmuxColor: null, paintedColor: null } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("already matches our target -- skip: already-matches (dedupe)", () => {
    const out = decideBackflow({ identityColor, hasRealColor: false, ref: { cmuxColor: targetHex, paintedColor: targetHex } });
    expect(out).toEqual({ action: "skip", reason: "already-matches" });
  });

  test("carries a stale paint of ours (target changed since) -- paint the new target", () => {
    const staleHex = "#000000";
    const out = decideBackflow({ identityColor, hasRealColor: false, ref: { cmuxColor: staleHex, paintedColor: staleHex } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("user cleared a color we'd painted (cmuxColor null, paintedColor set) -- repaint", () => {
    const out = decideBackflow({ identityColor, hasRealColor: false, ref: { cmuxColor: null, paintedColor: "#123456" } });
    expect(out).toEqual({ action: "paint", targetHex });
  });

  test("user set a real color we never painted -- skip: user-owned, never touch it", () => {
    const out = decideBackflow({
      identityColor,
      hasRealColor: false,
      ref: { cmuxColor: "#654321", paintedColor: null },
    });
    expect(out).toEqual({ action: "skip", reason: "user-owned" });
  });

  test("user overwrote our paint with a different color -- skip: user-owned, theirs wins", () => {
    const out = decideBackflow({
      identityColor,
      hasRealColor: false,
      ref: { cmuxColor: "#654321", paintedColor: "#123456" },
    });
    expect(out).toEqual({ action: "skip", reason: "user-owned" });
  });
});

describe("computeBackflowCandidates", () => {
  test("groupBy: workspace -- each ref is its own group, identity color from its own cmuxColor or title hash", () => {
    const refs = [ref({ id: "mw_a", title: "aaa", cmuxColor: null }), ref({ id: "mw_b", title: "bbb", cmuxColor: "#2779FB" })];
    const candidates = computeBackflowCandidates(refs, "workspace");
    expect(candidates).toHaveLength(2);
    const a = candidates.find((c) => c.refId === "mw_a")!;
    const b = candidates.find((c) => c.refId === "mw_b")!;
    expect(a.hasRealColor).toBe(false);
    expect(a.identityColor).toBe(colorFor("aaa", null));
    expect(b.hasRealColor).toBe(true);
    expect(b.identityColor).toBe(colorFor("bbb", "#2779FB"));
  });

  test("groupBy: title -- same-title refs share one identity color, real color wins if any member has one", () => {
    const refs = [
      ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: null }),
      ref({ id: "mw_b", sourceId: "cmux-b", title: "compliance", cmuxColor: "#2779FB" }),
    ];
    const candidates = computeBackflowCandidates(refs, "title");
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.hasRealColor).toBe(true);
      expect(c.identityColor).toBe(colorFor("compliance", "#2779FB"));
    }
  });

  test("archived refs are excluded entirely", () => {
    const refs = [ref({ id: "mw_a", archived: true })];
    expect(computeBackflowCandidates(refs, "workspace")).toEqual([]);
  });

  test("tmux-sourced refs never produce a candidate (nothing to cmux-actuator paint)", () => {
    const refs = [ref({ id: "mw_a", source: "cmux" }), ref({ id: "mw_b", source: "tmux", sourceId: "$1" })];
    const candidates = computeBackflowCandidates(refs, "workspace");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.refId).toBe("mw_a");
  });
});

describe("planBackflow", () => {
  test("end to end: a fresh title-hash-colored ref gets one paint action", () => {
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance" })];
    const candidates = computeBackflowCandidates(refs, "title");
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
    const candidates = computeBackflowCandidates(refs, "title");
    expect(planBackflow(candidates)).toEqual([]);
  });

  test("end to end: an already-matching ref produces zero actions (no redundant set-color calls)", () => {
    const target = CHROME_GROUP_REPRESENTATIVE_HEX[colorFor("compliance", null)];
    const refs = [ref({ id: "mw_a", sourceId: "cmux-a", title: "compliance", cmuxColor: target, paintedColor: target })];
    const candidates = computeBackflowCandidates(refs, "title");
    expect(planBackflow(candidates)).toEqual([]);
  });
});
