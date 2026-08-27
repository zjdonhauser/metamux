import { describe, expect, test } from "bun:test";
import { LazyGroupTracker } from "../src/lazy-groups.ts";
import type { ActuatorEvent, ActuatorWorkspace } from "../src/registry.ts";

function ws(id: string, overrides: Partial<ActuatorWorkspace> = {}): ActuatorWorkspace {
  return { id, title: overrides.title ?? id, color: overrides.color ?? "blue", archived: overrides.archived ?? false };
}

describe("LazyGroupTracker.markAttached / isAttached", () => {
  test("an identity is not attached until markAttached is called", () => {
    const tracker = new LazyGroupTracker();
    expect(tracker.isAttached("id1")).toBe(false);
  });

  test("markAttached marks it attached", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id1");
    expect(tracker.isAttached("id1")).toBe(true);
  });

  test("markAttached is idempotent -- the first timestamp wins", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id1", "2026-01-01T00:00:00.000Z");
    tracker.markAttached("id1", "2026-06-01T00:00:00.000Z");
    expect(tracker.attachedAtFor("id1")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("attachedAtFor returns null for an unattached identity", () => {
    const tracker = new LazyGroupTracker();
    expect(tracker.attachedAtFor("id1")).toBeNull();
  });
});

describe("LazyGroupTracker.filterForSync", () => {
  test("includes the currently active identity even if never attached", () => {
    const tracker = new LazyGroupTracker();
    const identities = [ws("id1"), ws("id2")];
    const result = tracker.filterForSync(identities, "id1");
    expect(result.map((i) => i.id)).toEqual(["id1"]);
  });

  test("includes a previously-attached identity even if not currently active", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id2");
    const result = tracker.filterForSync([ws("id1"), ws("id2")], "id1");
    expect(result.map((i) => i.id).sort()).toEqual(["id1", "id2"]);
  });

  test("excludes an identity that is neither active nor ever attached", () => {
    const tracker = new LazyGroupTracker();
    const result = tracker.filterForSync([ws("id1"), ws("id2"), ws("id3")], "id1");
    expect(result.map((i) => i.id)).toEqual(["id1"]);
  });

  test("with a null activeId, only previously-attached identities are included", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id2");
    const result = tracker.filterForSync([ws("id1"), ws("id2")], null);
    expect(result.map((i) => i.id)).toEqual(["id2"]);
  });
});

describe("LazyGroupTracker.filterEvents", () => {
  test("suppresses an upserted event for an identity that is neither active nor attached", () => {
    const tracker = new LazyGroupTracker();
    const events: ActuatorEvent[] = [{ name: "workspace.upserted", workspace: ws("id1") }];
    expect(tracker.filterEvents(events, null)).toEqual([]);
  });

  test("passes an upserted event through when the identity is currently active", () => {
    const tracker = new LazyGroupTracker();
    const events: ActuatorEvent[] = [{ name: "workspace.upserted", workspace: ws("id1") }];
    expect(tracker.filterEvents(events, "id1")).toEqual(events);
  });

  test("passes an upserted event through when the identity was already attached", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id1");
    const events: ActuatorEvent[] = [{ name: "workspace.upserted", workspace: ws("id1") }];
    expect(tracker.filterEvents(events, null)).toEqual(events);
  });

  test("activated and archived events always pass through regardless of attach status", () => {
    const tracker = new LazyGroupTracker();
    const events: ActuatorEvent[] = [
      { name: "workspace.activated", workspace: ws("id1") },
      { name: "workspace.archived", workspace: ws("id2") },
    ];
    expect(tracker.filterEvents(events, null)).toEqual(events);
  });

  test("a mixed batch keeps non-upserted events and filters only unattached upserted ones", () => {
    const tracker = new LazyGroupTracker();
    tracker.markAttached("id1");
    const events: ActuatorEvent[] = [
      { name: "workspace.upserted", workspace: ws("id1") }, // attached -- kept
      { name: "workspace.upserted", workspace: ws("id2") }, // not attached, not active -- dropped
      { name: "workspace.activated", workspace: ws("id2") }, // always kept
    ];
    const result = tracker.filterEvents(events, null);
    expect(result.length).toBe(2);
    expect(result[0]!.workspace.id).toBe("id1");
    expect(result[1]!.name).toBe("workspace.activated");
  });
});
