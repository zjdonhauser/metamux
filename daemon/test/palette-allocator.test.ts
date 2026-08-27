import { describe, expect, test } from "bun:test";
import { claimPaletteIndex, type PaletteHolder } from "../src/palette-allocator.ts";

function holder(identityKey: string, live: boolean, paletteIndex: number | null): PaletteHolder {
  return { identityKey, live, paletteIndex };
}

describe("claimPaletteIndex", () => {
  test("claims index 0 when nothing else is held", () => {
    expect(claimPaletteIndex("alpha", [], 9)).toBe(0);
  });

  test("claims the lowest index not held by another live identity", () => {
    const holders = [holder("alpha", true, 0), holder("beta", true, 1)];
    expect(claimPaletteIndex("gamma", holders, 9)).toBe(2);
  });

  test("skips over gaps correctly (held = {0, 2}, next free is 1)", () => {
    const holders = [holder("alpha", true, 0), holder("beta", true, 2)];
    expect(claimPaletteIndex("gamma", holders, 9)).toBe(1);
  });

  test("is idempotent: an identity already holding a live index keeps it, never reshuffled", () => {
    const holders = [holder("alpha", true, 5)];
    expect(claimPaletteIndex("alpha", holders, 9)).toBe(5);
  });

  test("re-claiming does not change even when a lower index has since freed up", () => {
    // alpha holds 5; nothing holds 0-4 anymore (they were released) -- alpha
    // must NOT be pulled down to 0 just because it's now available.
    const holders = [holder("alpha", true, 5)];
    expect(claimPaletteIndex("alpha", holders, 9)).toBe(5);
  });

  test("ignores this identity's OWN other (non-live or stale) refs when computing held", () => {
    // alpha has an archived/detached ref that still carries a stale index 0
    // (live: false) -- that must not count against alpha's own fresh claim,
    // nor against anyone else's.
    const holders = [holder("alpha", false, 0)];
    expect(claimPaletteIndex("alpha", holders, 9)).toBe(0);
    expect(claimPaletteIndex("beta", holders, 9)).toBe(0);
  });

  test("a released index (live: false) becomes available to a new claimant", () => {
    const holders = [holder("alpha", false, 0), holder("beta", true, 1)];
    expect(claimPaletteIndex("gamma", holders, 9)).toBe(0);
  });

  test("re-attaching after release may land on a DIFFERENT index (no memory of a prior claim)", () => {
    // alpha previously held 0 but is now released (live: false); beta has
    // since claimed 0. alpha's fresh claim must be pushed to whatever's
    // free now, not fight beta for its old slot.
    const holders = [holder("alpha", false, 0), holder("beta", true, 0)];
    expect(claimPaletteIndex("alpha", holders, 9)).toBe(1);
  });

  test("null paletteIndex entries never count as held", () => {
    const holders = [holder("alpha", true, null)];
    expect(claimPaletteIndex("beta", holders, 9)).toBe(0);
  });

  test("multiple refs sharing one identityKey (a title alias) converge on the same held index", () => {
    // Two real workspace refs both aliased under "compliance" -- only ONE
    // needs to carry the live index for the whole identity to read as held.
    const holders = [holder("compliance", true, 3), holder("compliance", true, null)];
    expect(claimPaletteIndex("other", holders, 9)).toBe(0);
    // held = {3}, so "other" doesn't collide with 3
    const held3 = new Set(
      Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== claimPaletteIndex("other", holders, 9)),
    );
    expect(held3.has(3)).toBe(true);
  });

  test("returns null when the entire palette is held by other identities", () => {
    const holders = [0, 1, 2].map((i) => holder(`id${i}`, true, i));
    expect(claimPaletteIndex("new", holders, 3)).toBe(null);
  });

  test("total across a large palette: claims scale up to paletteSize - 1", () => {
    const holders = Array.from({ length: 15 }, (_, i) => holder(`id${i}`, true, i));
    expect(claimPaletteIndex("new", holders, 16)).toBe(15);
  });
});
