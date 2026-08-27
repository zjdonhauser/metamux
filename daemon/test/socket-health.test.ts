import { describe, expect, test } from "bun:test";
import { SocketHealthMonitor } from "../src/socket-health.ts";

describe("SocketHealthMonitor -- initial state", () => {
  test("starts enabled when constructed enabled", () => {
    const monitor = new SocketHealthMonitor("enabled");
    expect(monitor.getState()).toBe("enabled");
  });

  test("starts disabled when constructed disabled", () => {
    const monitor = new SocketHealthMonitor("disabled");
    expect(monitor.getState()).toBe("disabled");
  });
});

describe("SocketHealthMonitor.recordCallOutcome -- the failure-streak breaker", () => {
  test("a single success while enabled is a no-op (no transition)", () => {
    const monitor = new SocketHealthMonitor("enabled");
    expect(monitor.recordCallOutcome(true)).toBeNull();
    expect(monitor.getState()).toBe("enabled");
  });

  test("1 or 2 consecutive failures do not trip the breaker (threshold is 3)", () => {
    const monitor = new SocketHealthMonitor("enabled");
    expect(monitor.recordCallOutcome(false)).toBeNull();
    expect(monitor.getState()).toBe("enabled");
    expect(monitor.recordCallOutcome(false)).toBeNull();
    expect(monitor.getState()).toBe("enabled");
  });

  test("the 3rd consecutive failure trips the breaker to disabled and returns the transition", () => {
    const monitor = new SocketHealthMonitor("enabled");
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false);
    const transition = monitor.recordCallOutcome(false);
    expect(transition).toEqual({ from: "enabled", to: "disabled", reason: "consecutive-failures" });
    expect(monitor.getState()).toBe("disabled");
  });

  test("a success between failures resets the streak -- 2 failures + success + 2 failures never trips", () => {
    const monitor = new SocketHealthMonitor("enabled");
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(true); // resets the streak
    monitor.recordCallOutcome(false);
    const transition = monitor.recordCallOutcome(false);
    expect(transition).toBeNull();
    expect(monitor.getState()).toBe("enabled");
  });

  test("call outcomes are ignored while already disabled (only the probe can recover)", () => {
    const monitor = new SocketHealthMonitor("disabled");
    expect(monitor.recordCallOutcome(true)).toBeNull();
    expect(monitor.recordCallOutcome(false)).toBeNull();
    expect(monitor.getState()).toBe("disabled");
  });

  test("after tripping, the streak is reset so a FRESH set of 3 failures is needed to trip again post-recovery", () => {
    const monitor = new SocketHealthMonitor("enabled");
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false); // trips
    monitor.recordProbeOutcome(true); // recovers
    expect(monitor.recordCallOutcome(false)).toBeNull();
    expect(monitor.recordCallOutcome(false)).toBeNull();
    const thirdTransition = monitor.recordCallOutcome(false);
    expect(thirdTransition).toEqual({ from: "enabled", to: "disabled", reason: "consecutive-failures" });
  });
});

describe("SocketHealthMonitor.recordProbeOutcome -- the cheap recovery path", () => {
  test("a failed probe while disabled is a no-op, stays disabled", () => {
    const monitor = new SocketHealthMonitor("disabled");
    expect(monitor.recordProbeOutcome(false)).toBeNull();
    expect(monitor.getState()).toBe("disabled");
  });

  test("a successful probe while disabled recovers to enabled and returns the transition", () => {
    const monitor = new SocketHealthMonitor("disabled");
    const transition = monitor.recordProbeOutcome(true);
    expect(transition).toEqual({ from: "disabled", to: "enabled", reason: "probe-recovered" });
    expect(monitor.getState()).toBe("enabled");
  });

  test("probe outcomes are ignored while already enabled (never probe while healthy)", () => {
    const monitor = new SocketHealthMonitor("enabled");
    expect(monitor.recordProbeOutcome(true)).toBeNull();
    expect(monitor.recordProbeOutcome(false)).toBeNull();
    expect(monitor.getState()).toBe("enabled");
  });

  test("recovery resets the failure streak (a lone failure right after recovery does not almost-trip)", () => {
    const monitor = new SocketHealthMonitor("enabled");
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false); // 2 failures, one away from tripping
    monitor.recordCallOutcome(false); // trips to disabled
    monitor.recordProbeOutcome(true); // recovers
    // if the streak weren't reset, a single failure here would look like "3rd" and re-trip
    const transition = monitor.recordCallOutcome(false);
    expect(transition).toBeNull();
    expect(monitor.getState()).toBe("enabled");
  });
});

describe("SocketHealthMonitor -- full lifecycle", () => {
  test("enabled -> 3 failures -> disabled -> failed probes -> successful probe -> enabled -> 3 more failures -> disabled again", () => {
    const monitor = new SocketHealthMonitor("enabled");
    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false);
    expect(monitor.recordCallOutcome(false)).toEqual({ from: "enabled", to: "disabled", reason: "consecutive-failures" });

    expect(monitor.recordProbeOutcome(false)).toBeNull();
    expect(monitor.recordProbeOutcome(false)).toBeNull();
    expect(monitor.recordProbeOutcome(true)).toEqual({ from: "disabled", to: "enabled", reason: "probe-recovered" });

    monitor.recordCallOutcome(false);
    monitor.recordCallOutcome(false);
    expect(monitor.recordCallOutcome(false)).toEqual({ from: "enabled", to: "disabled", reason: "consecutive-failures" });
  });
});
