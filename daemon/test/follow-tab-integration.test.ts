import { describe, expect, test } from "bun:test";
import { WindowPairing } from "../src/window-pairing.ts";
import { decideFollowTab } from "../src/follow-tab.ts";
import { titleAliasId } from "../src/group-projection.ts";
import type { CGWindow, Display } from "../src/window-join.ts";

// Drives the real pairing layer and the real decision against a two-display
// world, so the whole follow-the-tab chain is proven without a live browser.
// Only the Chrome call itself is out of scope here.

const DISPLAYS: Display[] = [
  { id: 0, bounds: { x: 0, y: 0, w: 2560, h: 1440 } },
  { id: 1, bounds: { x: -1539, y: -1080, w: 1920, h: 1080 } },
];

const spaceA: CGWindow[] = [
  { id: 100, owner: "cmux", bounds: { x: 0, y: 0, w: 1274, h: 1440 } },
  { id: 200, owner: "Google Chrome", bounds: { x: 1286, y: 0, w: 1274, h: 1440 } },
];
const spaceB: CGWindow[] = [
  { id: 101, owner: "cmux", bounds: { x: -1539, y: -1080, w: 954, h: 1080 } },
  { id: 201, owner: "Google Chrome", bounds: { x: -573, y: -1080, w: 954, h: 1080 } },
];
const chromeReported = [
  { id: 42, bounds: { x: 1286, y: 0, w: 1274, h: 1440 } },
  { id: 43, bounds: { x: -573, y: -1080, w: 954, h: 1080 } },
];

/** The exact composition main.ts performs on workspace.selected. */
function decide(p: WindowPairing, title: string, from: string | null, to: string | null) {
  return decideFollowTab({
    enabled: true,
    pairingHealthy: p.healthy,
    aliasId: titleAliasId(title),
    previousCmuxWindowId: from,
    currentCmuxWindowId: to,
    chromeWindowForCurrent: to ? p.chromeWindowFor(to) : null,
    chromeWindowForPrevious: from ? p.chromeWindowFor(from) : null,
  });
}

describe("follow-the-tab, end to end through the real pairing layer", () => {
  test("a workspace moved to another window moves its group to that window's Chrome", () => {
    const p = new WindowPairing();

    // Learn both Spaces the way activations would, one visible at a time.
    p.ingest(spaceA, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-A");
    p.ingest(spaceB, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-B");

    const move = decide(p, "compliance", "CMUX-WIN-A", "CMUX-WIN-B");
    expect(move).toEqual({
      kind: "move",
      aliasId: titleAliasId("compliance"),
      toChromeWindowId: 43,
    });
  });

  test("moving back returns the group to the first window's Chrome", () => {
    const p = new WindowPairing();
    p.ingest(spaceA, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-A");
    p.ingest(spaceB, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-B");
    p.ingest(spaceA, chromeReported, DISPLAYS);

    expect(decide(p, "compliance", "CMUX-WIN-B", "CMUX-WIN-A")?.toChromeWindowId).toBe(42);
  });

  // The destination is off-Space and invisible, which is the normal case when
  // you move a workspace to a window on another desktop.
  test("resolves a destination that is not currently visible", () => {
    const p = new WindowPairing();
    p.ingest(spaceB, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-B");
    p.ingest(spaceA, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-A");

    // Only Space A is on screen, yet B's binding is remembered.
    expect(decide(p, "compliance", "CMUX-WIN-A", "CMUX-WIN-B")?.toChromeWindowId).toBe(43);
  });

  test("declines while the invariant is violated", () => {
    const p = new WindowPairing();
    p.ingest(spaceA, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-A");
    p.ingest(spaceB, chromeReported, DISPLAYS);
    p.noteActivation("CMUX-WIN-B");

    p.ingest(
      [...spaceA, { id: 999, owner: "Google Chrome", bounds: { x: 40, y: 40, w: 900, h: 700 } }],
      chromeReported,
      DISPLAYS,
    );
    expect(p.healthy).toBe(false);
    expect(decide(p, "compliance", "CMUX-WIN-A", "CMUX-WIN-B")).toBeNull();
  });

  test("declines when the helper stalls and the snapshot goes stale", () => {
    const p = new WindowPairing({ staleAfterMs: 5_000 });
    p.ingest(spaceA, chromeReported, DISPLAYS, 1_000);
    p.noteActivation("CMUX-WIN-A", 1_000);
    p.ingest(spaceB, chromeReported, DISPLAYS, 2_000);
    p.noteActivation("CMUX-WIN-B", 2_000);

    expect(p.healthyAt(30_000)).toBe(false);
    expect(p.chromeWindowFor("CMUX-WIN-B", 30_000)).toBeNull();
  });
});
