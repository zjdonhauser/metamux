import { describe, expect, test } from "bun:test";
import { LazyGroupTracker } from "../src/lazy-groups.ts";
import type { ActuatorEvent, ActuatorWorkspace, WorkspaceRef } from "../src/registry.ts";

function ws(id: string, overrides: Partial<ActuatorWorkspace> = {}): ActuatorWorkspace {
  return { id, title: overrides.title ?? id, color: overrides.color ?? "blue", archived: overrides.archived ?? false };
}

function ref(overrides: Partial<WorkspaceRef> = {}): WorkspaceRef {
  return {
    id: overrides.id ?? "mw_a",
    title: overrides.title ?? "cmux",
    cwd: overrides.cwd ?? "/repo",
    source: "cmux",
    sourceId: overrides.sourceId ?? "SRC-A",
    archived: overrides.archived ?? false,
    cmuxColor: overrides.cmuxColor ?? null,
    attachedAt: overrides.attachedAt ?? null,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
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

describe("LazyGroupTracker.seedFromRefs", () => {
  test("seeds attachment for a ref with a persisted attachedAt (groupBy: workspace -- identityFor returns the ref's own id)", () => {
    const tracker = new LazyGroupTracker();
    const attached = ref({ id: "mw_a", attachedAt: "2026-01-01T00:00:00.000Z" });
    tracker.seedFromRefs([attached], (r) => r.id);
    expect(tracker.isAttached("mw_a")).toBe(true);
    expect(tracker.attachedAtFor("mw_a")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("does not seed a ref with attachedAt: null", () => {
    const tracker = new LazyGroupTracker();
    const neverAttached = ref({ id: "mw_a", attachedAt: null });
    tracker.seedFromRefs([neverAttached], (r) => r.id);
    expect(tracker.isAttached("mw_a")).toBe(false);
  });

  test("alias-level attachment = any member attached: two same-title refs seed the SAME alias id", () => {
    const tracker = new LazyGroupTracker();
    const attachedMember = ref({ id: "mw_a", title: "cmux", attachedAt: "2026-01-01T00:00:00.000Z" });
    const neverAttachedMember = ref({ id: "mw_b", title: "cmux", attachedAt: null });
    // identityFor simulates title-aliasing: both members map to the same "t_cmux" identity
    const identityFor = (r: WorkspaceRef) => `t_${r.title}`;
    tracker.seedFromRefs([attachedMember, neverAttachedMember], identityFor);
    expect(tracker.isAttached("t_cmux")).toBe(true);
  });

  test("survives a restart scenario: re-seeding after markAttached during a prior 'session' preserves the earliest timestamp", () => {
    const tracker = new LazyGroupTracker();
    const persisted = ref({ id: "mw_a", attachedAt: "2026-01-01T00:00:00.000Z" });
    tracker.seedFromRefs([persisted], (r) => r.id);
    // a second seeding call (e.g. re-run at a later point) with the same persisted timestamp is a no-op
    tracker.seedFromRefs([persisted], (r) => r.id);
    expect(tracker.attachedAtFor("mw_a")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("an empty refs list is a no-op", () => {
    const tracker = new LazyGroupTracker();
    expect(() => tracker.seedFromRefs([], (r) => r.id)).not.toThrow();
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
