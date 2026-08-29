import { describe, expect, test } from "bun:test";
import { decideFollowTab, type FollowTabInput } from "../src/follow-tab.ts";

const base: FollowTabInput = {
  enabled: true,
  pairingHealthy: true,
  aliasId: "t_0faa4b2a",
  previousCmuxWindowId: "WIN-A",
  currentCmuxWindowId: "WIN-B",
  chromeWindowForCurrent: 42,
  chromeWindowForPrevious: 17,
};

describe("decideFollowTab", () => {
  test("moves the group when the workspace changed cmux windows", () => {
    expect(decideFollowTab(base)).toEqual({
      kind: "move",
      aliasId: "t_0faa4b2a",
      toChromeWindowId: 42,
    });
  });

  test("does nothing when the workspace stayed put", () => {
    expect(decideFollowTab({ ...base, currentCmuxWindowId: "WIN-A" })).toBeNull();
  });

  test("does nothing when the feature is off", () => {
    expect(decideFollowTab({ ...base, enabled: false })).toBeNull();
  });

  // An unhealthy pairing means the invariant broke or the helper stalled.
  // Falling back is the whole safety story; acting on a guess is not.
  test("does nothing when the pairing is unhealthy", () => {
    expect(decideFollowTab({ ...base, pairingHealthy: false })).toBeNull();
  });

  test("does nothing when the destination has no known Chrome window", () => {
    expect(decideFollowTab({ ...base, chromeWindowForCurrent: null })).toBeNull();
  });

  // First time we have ever seen this workspace: not a move, just a sighting.
  test("does nothing on a first sighting with no previous window", () => {
    expect(decideFollowTab({ ...base, previousCmuxWindowId: null })).toBeNull();
  });

  // Two cmux windows paired to the same Chrome window: the group is already
  // where it belongs, so moving it would be a no-op write.
  test("does nothing when both cmux windows resolve to the same Chrome window", () => {
    expect(decideFollowTab({ ...base, chromeWindowForPrevious: 42 })).toBeNull();
  });

  test("still moves when the previous Chrome window is unknown", () => {
    const d = decideFollowTab({ ...base, chromeWindowForPrevious: null });
    expect(d).toEqual({ kind: "move", aliasId: "t_0faa4b2a", toChromeWindowId: 42 });
  });

  test("does nothing without an alias to move", () => {
    expect(decideFollowTab({ ...base, aliasId: null })).toBeNull();
  });
});
