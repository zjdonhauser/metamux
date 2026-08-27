import { describe, expect, test } from "bun:test";
import { BackflowFailureTracker } from "../src/backflow-failure-tracker.ts";

describe("BackflowFailureTracker", () => {
  test("a fresh target has never given up", () => {
    const tracker = new BackflowFailureTracker(3);
    expect(tracker.isGivenUp("mw_a")).toBe(false);
  });

  test("failures below the threshold report keep-retrying", () => {
    const tracker = new BackflowFailureTracker(3);
    expect(tracker.recordFailure("mw_a")).toBe("keep-retrying");
    expect(tracker.recordFailure("mw_a")).toBe("keep-retrying");
    expect(tracker.isGivenUp("mw_a")).toBe(false);
  });

  test("the failure that reaches the threshold reports just-gave-up exactly once", () => {
    const tracker = new BackflowFailureTracker(3);
    tracker.recordFailure("mw_a");
    tracker.recordFailure("mw_a");
    expect(tracker.recordFailure("mw_a")).toBe("just-gave-up");
    expect(tracker.isGivenUp("mw_a")).toBe(true);
  });

  test("every failure after giving up reports already-given-up (log once, not every poll)", () => {
    const tracker = new BackflowFailureTracker(2);
    tracker.recordFailure("mw_a");
    expect(tracker.recordFailure("mw_a")).toBe("just-gave-up");
    expect(tracker.recordFailure("mw_a")).toBe("already-given-up");
    expect(tracker.recordFailure("mw_a")).toBe("already-given-up");
  });

  test("recordSuccess clears the failure count so a recovered target isn't primed to give up early", () => {
    const tracker = new BackflowFailureTracker(3);
    tracker.recordFailure("mw_a");
    tracker.recordFailure("mw_a");
    tracker.recordSuccess("mw_a");
    expect(tracker.recordFailure("mw_a")).toBe("keep-retrying");
    expect(tracker.recordFailure("mw_a")).toBe("keep-retrying");
    expect(tracker.recordFailure("mw_a")).toBe("just-gave-up");
  });

  test("recordSuccess un-gives-up a target that starts working again (e.g. re-created with the same sourceId)", () => {
    const tracker = new BackflowFailureTracker(2);
    tracker.recordFailure("mw_a");
    tracker.recordFailure("mw_a");
    expect(tracker.isGivenUp("mw_a")).toBe(true);
    tracker.recordSuccess("mw_a");
    expect(tracker.isGivenUp("mw_a")).toBe(false);
  });

  test("targets are tracked independently", () => {
    const tracker = new BackflowFailureTracker(2);
    tracker.recordFailure("mw_a");
    tracker.recordFailure("mw_a");
    expect(tracker.isGivenUp("mw_a")).toBe(true);
    expect(tracker.isGivenUp("mw_b")).toBe(false);
  });
});
