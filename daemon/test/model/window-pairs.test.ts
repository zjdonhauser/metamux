import { describe, expect, test } from "bun:test";
import { resolvePairs } from "../../src/model/window-pairs.ts";

const CMUX = ["cw1", "cw2"];
const CHROME = ["CH1", "CH2"];
const pair = { cmuxWindowId: "cw1", chromeWindowId: "CH1" };

describe("resolvePairs", () => {
  test("keeps a pair whose ends are both still live", () => {
    expect(resolvePairs([pair], CMUX, CHROME, null)).toEqual({ pairs: [pair], changed: false });
  });

  // The whole point of remembering: a pair stays usable while its windows sit
  // on a Space that is not currently on screen. Only true absence drops it.
  test("keeps a pair with no observation this pass", () => {
    const { pairs } = resolvePairs([pair], CMUX, CHROME, null);
    expect(pairs).toEqual([pair]);
  });

  test("drops a pair whose cmux window is gone", () => {
    expect(resolvePairs([pair], ["cw2"], CHROME, null)).toEqual({ pairs: [], changed: true });
  });

  test("drops a pair whose Chrome window is gone", () => {
    expect(resolvePairs([pair], CMUX, ["CH2"], null)).toEqual({ pairs: [], changed: true });
  });

  test("binds a new pair from an observation", () => {
    const { pairs, changed } = resolvePairs([], CMUX, CHROME, { cmuxWindowId: "cw1", chromeWindowId: "CH1" });
    expect(pairs).toEqual([pair]);
    expect(changed).toBe(true);
  });

  test("re-observing an existing pair changes nothing", () => {
    const { changed } = resolvePairs([pair], CMUX, CHROME, { cmuxWindowId: "cw1", chromeWindowId: "CH1" });
    expect(changed).toBe(false);
  });

  // One-to-one in both directions. Without eviction a cmux window could hold
  // two Chrome windows and the desired path would be ambiguous.
  test("a new observation evicts the old pair for that cmux window", () => {
    const { pairs } = resolvePairs([pair], CMUX, CHROME, { cmuxWindowId: "cw1", chromeWindowId: "CH2" });
    expect(pairs).toEqual([{ cmuxWindowId: "cw1", chromeWindowId: "CH2" }]);
  });

  test("a new observation evicts the old pair for that Chrome window", () => {
    const { pairs } = resolvePairs([pair], CMUX, CHROME, { cmuxWindowId: "cw2", chromeWindowId: "CH1" });
    expect(pairs).toEqual([{ cmuxWindowId: "cw2", chromeWindowId: "CH1" }]);
  });

  // Refusing beats guessing: a stale observation must not resurrect a dead window.
  test("ignores an observation naming a window that is not live", () => {
    expect(resolvePairs([], CMUX, CHROME, { cmuxWindowId: "gone", chromeWindowId: "CH1" }).pairs).toEqual([]);
    expect(resolvePairs([], CMUX, CHROME, { cmuxWindowId: "cw1", chromeWindowId: "gone" }).pairs).toEqual([]);
  });

  test("never invents a pair without an observation", () => {
    expect(resolvePairs([], CMUX, CHROME, null)).toEqual({ pairs: [], changed: false });
  });

  test("holds two independent pairs at once", () => {
    const both = [pair, { cmuxWindowId: "cw2", chromeWindowId: "CH2" }];
    expect(resolvePairs(both, CMUX, CHROME, null).pairs).toEqual(both);
  });
});
