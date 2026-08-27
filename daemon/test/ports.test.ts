import { describe, expect, test } from "bun:test";
import { PortsTracker } from "../src/ports.ts";

describe("PortsTracker.diff -- baseline guard", () => {
  test("the first poll for a workspace establishes a baseline and emits nothing", () => {
    const tracker = new PortsTracker();
    const result = tracker.diff("W1", [3000, 3001]);
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("baseline ports are still shown via portsFor (visible in /state, just never actioned)", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000, 3001]);
    expect(tracker.portsFor("W1").sort()).toEqual([3000, 3001]);
  });

  test("re-polling the same baseline ports on a later cycle emits nothing (not new)", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000, 3001]);
    const result = tracker.diff("W1", [3000, 3001]);
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("a port appearing on a LATER poll (after the baseline) is a fresh auto-open candidate", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000]); // baseline
    const result = tracker.diff("W1", [3000, 4000]); // 4000 is new
    expect(result.autoOpen).toEqual([4000]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("baseline is per-workspace: workspace B's first poll is its own baseline even if A has already emitted", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000]); // A's baseline
    tracker.diff("W1", [3000, 4000]); // A: 4000 emits
    const result = tracker.diff("W2", [3000]); // B's FIRST poll -- baseline, not a re-sighting
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });
});

describe("PortsTracker.diff -- ephemeral cutoff", () => {
  test("a port >= 49152 (default maxPort 49151) is never auto-opened, even on a later poll", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // baseline
    const result = tracker.diff("W1", [60952]);
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("an ephemeral port is still visible via portsFor (shown in /state and the panel)", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []);
    tracker.diff("W1", [60952]);
    expect(tracker.portsFor("W1")).toEqual([60952]);
  });

  test("a normal dev-server port like 5173 IS a valid candidate", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // baseline
    const result = tracker.diff("W1", [5173]);
    expect(result.autoOpen).toEqual([5173]);
  });

  test("49151 itself (the default maxPort boundary) is still actionable -- the cutoff is exclusive", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []);
    const result = tracker.diff("W1", [49151]);
    expect(result.autoOpen).toEqual([49151]);
  });

  test("a custom maxPort option is honored", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [], { maxPort: 8000 });
    const result = tracker.diff("W1", [8080], { maxPort: 8000 });
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });
});

describe("PortsTracker.diff -- per-cycle cap", () => {
  test("at most 2 auto-opens per poll cycle by default; the rest go to notifyOnly", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // baseline
    const result = tracker.diff("W1", [3000, 3001, 3002, 3003]); // 4 fresh in one cycle
    expect(result.autoOpen).toEqual([3000, 3001]);
    expect(result.notifyOnly).toEqual([3002, 3003]);
  });

  test("a custom autoOpenCap option is honored", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []);
    const result = tracker.diff("W1", [3000, 3001, 3002], { autoOpenCap: 1 });
    expect(result.autoOpen).toEqual([3000]);
    expect(result.notifyOnly).toEqual([3001, 3002]);
  });

  test("ports over the cap in one cycle are still marked seen -- they don't re-emit on the next poll", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []);
    tracker.diff("W1", [3000, 3001, 3002, 3003]); // 3002, 3003 capped to notifyOnly
    const result = tracker.diff("W1", [3000, 3001, 3002, 3003]); // same set again
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("fewer fresh ports than the cap all land in autoOpen, none in notifyOnly", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []);
    const result = tracker.diff("W1", [3000]);
    expect(result.autoOpen).toEqual([3000]);
    expect(result.notifyOnly).toEqual([]);
  });
});

describe("PortsTracker.diff -- ignore list and lifetime dedupe (existing behavior, preserved)", () => {
  test("ignored ports never surface, even on a later poll", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // baseline
    const result = tracker.diff("W1", [3000, 22], { ignore: [22] });
    expect(result.autoOpen).toEqual([3000]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("ignored ports are excluded from portsFor() too", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000, 22], { ignore: [22] });
    expect(tracker.portsFor("W1")).toEqual([3000]);
  });

  test("a port disappearing and reappearing across polls is not re-surfaced (lifetime dedupe)", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // baseline
    tracker.diff("W1", [3000]); // fresh, emitted
    tracker.diff("W1", []); // port closed
    const result = tracker.diff("W1", [3000]); // port reopened
    expect(result.autoOpen).toEqual([]);
    expect(result.notifyOnly).toEqual([]);
  });

  test("dedupe is per (workspaceId, port) -- the same port on a different (already-baselined) workspace is new", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", []); // A baseline
    tracker.diff("W1", [3000]); // A: 3000 emits
    tracker.diff("W2", []); // B baseline
    const result = tracker.diff("W2", [3000]); // B: 3000 is fresh for B
    expect(result.autoOpen).toEqual([3000]);
  });

  test("portsFor returns the empty array for an unseen workspace", () => {
    const tracker = new PortsTracker();
    expect(tracker.portsFor("unknown")).toEqual([]);
  });

  test("portsFor reflects the latest poll, not the union of all-time-seen ports", () => {
    const tracker = new PortsTracker();
    tracker.diff("W1", [3000, 4000]);
    tracker.diff("W1", [4000]); // 3000 closed
    expect(tracker.portsFor("W1")).toEqual([4000]);
  });
});
