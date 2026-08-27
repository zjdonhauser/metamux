import { describe, expect, test } from "bun:test";
import { hydrateRegistry, serializeRegistry } from "../src/main.ts";
import { GroupProjection } from "../src/group-projection.ts";
import { LazyGroupTracker } from "../src/lazy-groups.ts";
import { Registry } from "../src/registry.ts";
import type { PaletteEntry } from "../src/palette.ts";

/** Simulates a real disk round-trip: serialize -> JSON.stringify ->
 * JSON.parse -> hydrate, exactly what atomicWriteJson + readJsonOrDefault
 * do around a real daemon restart. */
function roundTrip(registry: Registry, namedSlots: Record<string, string> | null = null, palette: PaletteEntry[] = []): Registry {
  const serialized = serializeRegistry(registry);
  const onDisk = JSON.parse(JSON.stringify(serialized));
  return hydrateRegistry(onDisk, namedSlots, palette);
}

const TEST_PALETTE: PaletteEntry[] = [
  { name: "Navy", chromeColor: "grey" },
  { name: "Blue", chromeColor: "blue" },
];

describe("registry persistence round-trip -- attachedAt", () => {
  test("a workspace activated before 'restart' still shows attachedAt after re-hydration", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 2, occurredAtMs: 2 });
    const before = [...registry.workspaces.values()][0]!;
    expect(before.attachedAt).not.toBeNull();

    const restored = roundTrip(registry);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.attachedAt).toBe(before.attachedAt);
  });

  test("a never-activated workspace still shows attachedAt: null after re-hydration", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });

    const restored = roundTrip(registry);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.attachedAt).toBeNull();
  });

  test("a registry.json written before this feature (no attachedAt key at all) hydrates to null, not a crash", () => {
    const legacySaved = {
      workspaces: [
        {
          id: "mw_legacy",
          title: "old-workspace",
          cwd: "/old",
          source: "cmux" as const,
          sourceId: "SRC-LEGACY",
          archived: false,
          cmuxColor: null,
          updatedAt: new Date().toISOString(),
          // no attachedAt field at all -- simulates a pre-feature file
        },
      ],
      activeId: null,
    };
    const registry = hydrateRegistry(legacySaved as any, null);
    const ref = [...registry.workspaces.values()][0]!;
    expect(ref.attachedAt).toBeNull();
  });

  test("end-to-end: a restart does not re-hide a previously-attached group in lazy mode", () => {
    // Session 1: workspace gets created and activated (attaches it).
    const session1 = new Registry();
    session1.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    session1.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 2, occurredAtMs: 2 });

    // "Restart": hydrate a fresh registry from the persisted (round-tripped) state.
    const session2 = roundTrip(session1);

    // Fresh in-memory trackers, as main.ts constructs on every daemon start.
    const groupProjection = new GroupProjection("workspace");
    const lazyGroups = new LazyGroupTracker();
    const seedSnapshot = { workspaces: [...session2.workspaces.values()], activeId: session2.activeId };
    lazyGroups.seedFromRefs(seedSnapshot.workspaces, (ref) => groupProjection.identityFor(ref, seedSnapshot).id);

    const projected = groupProjection.projectState(seedSnapshot);
    const visible = lazyGroups.filterForSync(projected.workspaces);

    // Without seeding, this would be empty (nothing "active" this instant,
    // nothing attached this session) -- the bug this round-trip fixes.
    expect(visible.length).toBe(1);
    expect(visible[0]!.title).toBe("cmux");
  });
});

describe("registry persistence round-trip -- paintedColor (color backflow)", () => {
  test("a backflow-painted ref still shows paintedColor after re-hydration", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const id = [...registry.workspaces.values()][0]!.id;
    registry.markPainted(id, "#1a73e8");

    const restored = roundTrip(registry);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.paintedColor).toBe("#1a73e8");
  });

  test("a never-painted workspace still shows paintedColor: null after re-hydration", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });

    const restored = roundTrip(registry);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.paintedColor).toBeNull();
  });

  test("a registry.json written before this feature (no paintedColor key at all) hydrates to null, not a crash", () => {
    const legacySaved = {
      workspaces: [
        {
          id: "mw_legacy",
          title: "old-workspace",
          cwd: "/old",
          source: "cmux" as const,
          sourceId: "SRC-LEGACY",
          archived: false,
          cmuxColor: null,
          attachedAt: null,
          updatedAt: new Date().toISOString(),
          // no paintedColor field at all -- simulates a pre-feature file
        },
      ],
      activeId: null,
    };
    const registry = hydrateRegistry(legacySaved as any, null);
    const ref = [...registry.workspaces.values()][0]!;
    expect(ref.paintedColor).toBeNull();
  });
});

describe("registry persistence round-trip -- paletteIndex (palette allocation)", () => {
  test("an attached, colorMode: palette ref still shows its claimed index after re-hydration", () => {
    const registry = new Registry(null, TEST_PALETTE);
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const id = [...registry.workspaces.values()][0]!.id;
    registry.markAttached(id);
    expect(registry.workspaces.get(id)!.paletteIndex).toBe(0);

    const restored = roundTrip(registry, null, TEST_PALETTE);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.paletteIndex).toBe(0);
  });

  test("a restart does NOT reshuffle a still-attached identity's color -- restoring the same daemon state re-claims the same index", () => {
    const registry = new Registry(null, TEST_PALETTE);
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "aaa", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "bbb", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });
    const [idA, idB] = [...registry.workspaces.values()].map((r) => r.id);
    registry.markAttached(idA!);
    registry.markAttached(idB!);
    expect(registry.workspaces.get(idA!)!.paletteIndex).toBe(0);
    expect(registry.workspaces.get(idB!)!.paletteIndex).toBe(1);

    // hydrateRegistry restores the persisted stamps directly (no re-claim
    // pass) -- this is the restart-stability guarantee.
    const restored = roundTrip(registry, null, TEST_PALETTE);
    expect(restored.workspaces.get(idA!)!.paletteIndex).toBe(0);
    expect(restored.workspaces.get(idB!)!.paletteIndex).toBe(1);
  });

  test("a never-attached workspace still shows paletteIndex: null after re-hydration", () => {
    const registry = new Registry(null, TEST_PALETTE);
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });

    const restored = roundTrip(registry, null, TEST_PALETTE);
    const after = [...restored.workspaces.values()][0]!;
    expect(after.paletteIndex).toBeNull();
  });

  test("a registry.json written before this feature (no paletteIndex key at all) hydrates to null, not a crash", () => {
    const legacySaved = {
      workspaces: [
        {
          id: "mw_legacy",
          title: "old-workspace",
          cwd: "/old",
          source: "cmux" as const,
          sourceId: "SRC-LEGACY",
          archived: false,
          cmuxColor: null,
          attachedAt: "2026-01-01T00:00:00.000Z",
          paintedColor: null,
          updatedAt: new Date().toISOString(),
          // no paletteIndex field at all -- simulates a pre-feature file
        },
      ],
      activeId: null,
    };
    const registry = hydrateRegistry(legacySaved as any, null, TEST_PALETTE);
    const ref = [...registry.workspaces.values()][0]!;
    expect(ref.paletteIndex).toBeNull();
  });
});
