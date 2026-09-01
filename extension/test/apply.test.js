import { describe, expect, test } from "bun:test";
import { orderCalls, planChromeCall } from "../apply.js";
import { buildObservation } from "../observe.js";

const PANEL = "chrome-extension://abc/panel.html";
const OBS = buildObservation(
  [{ id: 7, type: "normal" }, { id: 8, type: "normal" }],
  [{ windowId: 7, url: `${PANEL}?win=CH-1` }, { windowId: 8, url: `${PANEL}?win=CH-2` }],
  [],
  PANEL,
);

describe("planChromeCall", () => {
  test("resolves a create to the numeric window", () => {
    expect(planChromeCall({ kind: "createGroup", workspaceId: "w1", label: "alpha", chromeWindowId: "CH-2" }, OBS)).toEqual({
      op: "createGroup",
      windowId: 8,
      label: "alpha",
      workspaceId: "w1",
    });
  });

  test("resolves a move to the numeric window", () => {
    expect(planChromeCall({ kind: "moveGroup", groupId: 10, toChromeWindowId: "CH-1" }, OBS)).toEqual({
      op: "moveGroup",
      groupId: 10,
      windowId: 7,
    });
  });

  // The failure this exists to prevent: retargeting at a neighbouring window
  // because the intended one is not on screen.
  test("skips rather than guessing when the minted window is not live", () => {
    expect(planChromeCall({ kind: "moveGroup", groupId: 10, toChromeWindowId: "CH-gone" }, OBS)).toEqual({
      op: "skip",
      reason: "no live window for CH-gone",
    });
    expect(planChromeCall({ kind: "createGroup", workspaceId: "w", label: "a", chromeWindowId: "CH-gone" }, OBS).op).toBe("skip");
  });

  test("passes group-local actions through untouched", () => {
    expect(planChromeCall({ kind: "mergeGroups", fromGroupId: 11, intoGroupId: 10 }, OBS)).toEqual({
      op: "mergeGroups",
      fromGroupId: 11,
      intoGroupId: 10,
    });
    expect(planChromeCall({ kind: "archiveGroup", groupId: 10 }, OBS)).toEqual({ op: "archiveGroup", groupId: 10 });
    expect(planChromeCall({ kind: "closeBlankGroup", groupId: 9 }, OBS)).toEqual({ op: "closeGroup", groupId: 9 });
  });

  // A group metamux did not create is reported, never touched.
  test("never acts on a foreign group", () => {
    expect(planChromeCall({ kind: "reportForeign", groupId: 99, label: "banking" }, OBS).op).toBe("skip");
  });
});

describe("orderCalls", () => {
  // A move must not run before the merge that decides which group survives,
  // or it moves a group that is about to be merged away.
  test("merges and closes run before creates and moves", () => {
    const ordered = orderCalls([
      { op: "moveGroup", groupId: 1, windowId: 7 },
      { op: "createGroup", windowId: 8, label: "a" },
      { op: "mergeGroups", fromGroupId: 2, intoGroupId: 1 },
      { op: "closeGroup", groupId: 3 },
    ]);
    expect(ordered.map((c) => c.op)).toEqual(["mergeGroups", "closeGroup", "createGroup", "moveGroup"]);
  });

  test("does not mutate its input", () => {
    const calls = [{ op: "moveGroup" }, { op: "mergeGroups" }];
    const before = JSON.stringify(calls);
    orderCalls(calls);
    expect(JSON.stringify(calls)).toBe(before);
  });
});
