import { describe, expect, test } from "bun:test";
import { resolvePairObservation } from "../src/identity-placement.ts";

const MAP = new Map([[42, "CH-1"]]);

describe("resolvePairObservation", () => {
  test("resolves a live pair through the numeric-to-minted map", () => {
    expect(resolvePairObservation("cw1", 42, MAP)).toEqual({ cmuxWindowId: "cw1", chromeWindowId: "CH-1" });
  });

  test("is null when the cmux window is unknown", () => {
    expect(resolvePairObservation(null, 42, MAP)).toBeNull();
  });

  test("is null when the geometry join has no Chrome window", () => {
    expect(resolvePairObservation("cw1", null, MAP)).toBeNull();
  });

  // No marker tab yet, or the marker fell out of the last observation: refuse
  // rather than guess, matching the model's rule everywhere else.
  test("is null when the numeric window carries no minted id", () => {
    expect(resolvePairObservation("cw1", 99, MAP)).toBeNull();
  });

  test("is null against an empty map", () => {
    expect(resolvePairObservation("cw1", 42, new Map())).toBeNull();
  });
});
