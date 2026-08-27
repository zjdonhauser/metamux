import { describe, expect, test } from "bun:test";
import { shouldReverseSyncSelect } from "../src/reverse-sync.ts";

describe("shouldReverseSyncSelect", () => {
  test("true when reverseSync is on, socket features are on, and the target differs from active", () => {
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: true,
        socketFeaturesEnabled: true,
        requestedId: "mw_target",
        activeId: "mw_other",
      }),
    ).toBe(true);
  });

  test("false when reverseSync config is off (default)", () => {
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: false,
        socketFeaturesEnabled: true,
        requestedId: "mw_target",
        activeId: "mw_other",
      }),
    ).toBe(false);
  });

  test("false when socket features are disabled", () => {
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: true,
        socketFeaturesEnabled: false,
        requestedId: "mw_target",
        activeId: "mw_other",
      }),
    ).toBe(false);
  });

  test("false when the requested id is already the active workspace (echo/loop guard)", () => {
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: true,
        socketFeaturesEnabled: true,
        requestedId: "mw_same",
        activeId: "mw_same",
      }),
    ).toBe(false);
  });

  test("false when activeId is null and requestedId is falsy-equal in JS terms (still distinct)", () => {
    // sanity: null activeId with a real requestedId is still a valid switch
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: true,
        socketFeaturesEnabled: true,
        requestedId: "mw_target",
        activeId: null,
      }),
    ).toBe(true);
  });

  test("all guards combined off still returns false, not throws", () => {
    expect(
      shouldReverseSyncSelect({
        reverseSyncEnabled: false,
        socketFeaturesEnabled: false,
        requestedId: "mw_x",
        activeId: "mw_x",
      }),
    ).toBe(false);
  });
});
