import { describe, expect, test } from "bun:test";
import { Gate } from "../src/gate.ts";
import type { CmuxWorkspaceEvent } from "../src/parser.ts";

function ev(
  name: CmuxWorkspaceEvent["name"],
  workspaceId: string,
  occurredAtMs: number,
  extra: Partial<CmuxWorkspaceEvent> = {},
): CmuxWorkspaceEvent {
  return {
    name,
    workspaceId,
    title: extra.title ?? "t",
    cwd: extra.cwd ?? null,
    bootId: extra.bootId ?? "B1",
    seq: extra.seq ?? 1,
    occurredAtMs,
  };
}

describe("Gate.setDebounceMs (config hot-reload)", () => {
  test("a new debounceMs takes effect on the NEXT selected event, not retroactively on a pending one", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("selected", "W1", 1000));
    expect(gate.nextDeadline()).toBe(1200); // scheduled under the old debounceMs

    gate.setDebounceMs(1000);
    expect(gate.nextDeadline()).toBe(1200); // untouched -- already scheduled

    const out = gate.feed(ev("selected", "W1", 2000)); // a fresh selected uses the new value
    expect(out).toEqual([]);
    expect(gate.nextDeadline()).toBe(3000);
  });
});

describe("Gate", () => {
  test("created events pass through immediately", () => {
    const gate = new Gate(200, 500);
    const out = gate.feed(ev("created", "W1", 1000));
    expect(out).toEqual([{ kind: "actuate", event: out[0]!.event }]);
    expect(out[0]!.event.name).toBe("created");
  });

  test("closed and renamed events pass through immediately", () => {
    const gate = new Gate(200, 500);
    const closed = gate.feed(ev("closed", "W1", 1000));
    expect(closed.length).toBe(1);
    expect(closed[0]!.kind).toBe("actuate");

    const renamed = gate.feed(ev("renamed", "W1", 1000));
    expect(renamed.length).toBe(1);
    expect(renamed[0]!.kind).toBe("actuate");
  });

  test("colored events pass through immediately, no debounce/suppression", () => {
    const gate = new Gate(200, 500);
    const colored = gate.feed({ ...ev("colored", "W1", 1000), color: "#2779FB" });
    expect(colored.length).toBe(1);
    expect(colored[0]!.kind).toBe("actuate");
    expect(gate.nextDeadline()).toBeNull();
  });

  test("a selected with no prior created for that workspace is debounced, not suppressed", () => {
    const gate = new Gate(200, 500);
    const out = gate.feed(ev("selected", "W1", 1000));
    // nothing emitted immediately -- it's pending
    expect(out).toEqual([]);
    expect(gate.nextDeadline()).toBe(1200);
  });

  test("selected within suppressMs AFTER created for the SAME workspace is dropped", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("created", "W1", 1000));
    const out = gate.feed(ev("selected", "W1", 1300)); // 300ms after create, < 500ms suppress window
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("dropped");
    expect(gate.nextDeadline()).toBeNull();
  });

  test("selected exactly at the suppress boundary (500ms) is still suppressed", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("created", "W1", 1000));
    const out = gate.feed(ev("selected", "W1", 1500));
    expect(out[0]!.kind).toBe("dropped");
  });

  test("selected just past the suppress window is debounced normally", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("created", "W1", 1000));
    const out = gate.feed(ev("selected", "W1", 1501));
    expect(out).toEqual([]);
    expect(gate.nextDeadline()).toBe(1701);
  });

  test("selected within suppress window for a DIFFERENT workspace is not suppressed", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("created", "W1", 1000));
    const out = gate.feed(ev("selected", "W2", 1200));
    expect(out).toEqual([]); // debounced pending, not dropped
    expect(gate.nextDeadline()).toBe(1400);
  });

  test("selected BEFORE created for the same workspace is not suppressed (suppression is create-then-select only)", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("selected", "W1", 900));
    const out = gate.feed(ev("created", "W1", 1000));
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("actuate");
    expect(out[0]!.event.name).toBe("created");
  });

  test("rapid selected events debounce to only the latest", () => {
    const gate = new Gate(200, 500);
    const a = gate.feed(ev("selected", "W1", 1000));
    expect(a).toEqual([]);
    expect(gate.nextDeadline()).toBe(1200);

    const b = gate.feed(ev("selected", "W2", 1050));
    expect(b).toEqual([]); // supersedes W1's pending selection, nothing emitted for W1 either
    expect(gate.nextDeadline()).toBe(1250);

    // poll before the new deadline: nothing fires yet
    expect(gate.poll(1200)).toBeNull();
    // poll at/after the new deadline: the LATEST (W2) selection fires
    const flushed = gate.poll(1250);
    expect(flushed).not.toBeNull();
    expect(flushed!.event.workspaceId).toBe("W2");
  });

  test("poll returns null when nothing is pending", () => {
    const gate = new Gate(200, 500);
    expect(gate.poll(999999)).toBeNull();
  });

  test("poll does not fire before readyAt", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("selected", "W1", 1000));
    expect(gate.poll(1199)).toBeNull();
    expect(gate.poll(1200)).not.toBeNull();
  });

  test("poll consumes the pending event -- calling twice only fires once", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("selected", "W1", 1000));
    const first = gate.poll(1200);
    expect(first).not.toBeNull();
    const second = gate.poll(1200);
    expect(second).toBeNull();
    expect(gate.nextDeadline()).toBeNull();
  });

  test("suppression only applies to the most recent created for that workspace", () => {
    const gate = new Gate(200, 500);
    gate.feed(ev("created", "W1", 1000));
    gate.feed(ev("created", "W1", 5000)); // a later re-create resets the suppression window
    const out = gate.feed(ev("selected", "W1", 5200));
    expect(out[0]!.kind).toBe("dropped");

    const gate2 = new Gate(200, 500);
    gate2.feed(ev("created", "W1", 1000));
    gate2.feed(ev("created", "W1", 5000));
    const out2 = gate2.feed(ev("selected", "W1", 1200)); // would've been in window of the FIRST create only
    expect(out2).toEqual([]); // not suppressed relative to the latest create at 5000
  });
});
