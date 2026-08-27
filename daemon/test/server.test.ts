import { describe, expect, test } from "bun:test";
import { ActuatorServer } from "../src/server.ts";
import { DEFAULT_CONFIG, type MetamuxConfig } from "../src/config.ts";
import { GroupProjection } from "../src/group-projection.ts";
import { LazyGroupTracker } from "../src/lazy-groups.ts";
import { Registry } from "../src/registry.ts";

// These exercise ActuatorServer's broadcast/getState/pushOpenUrl wiring
// directly (no .start(), no real port) -- they don't depend on real WS
// clients since broadcastRaw's client loop is a no-op with none connected,
// and the injected `log` callback lets us observe exactly what a real
// client would have received.

function cfg(overrides: Partial<MetamuxConfig> = {}): MetamuxConfig {
  return { ...DEFAULT_CONFIG, ports: { ...DEFAULT_CONFIG.ports }, ...overrides };
}

function makeServer(config: MetamuxConfig, registry: Registry) {
  const logs: string[] = [];
  const server = new ActuatorServer({
    port: 0,
    secret: "test-secret",
    registry,
    config,
    cursor: { bootId: "B1", seq: 1 },
    stats: { skippedLines: 0 },
    groupProjection: new GroupProjection(config.groupBy),
    lazyGroups: new LazyGroupTracker(),
    log: (line) => logs.push(line),
  });
  return { server, logs };
}

describe("ActuatorServer.broadcast -- groupBy: title", () => {
  test("two same-title workspaces upserting both log only ONE alias line", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "title", createGroups: "eager" }), registry);

    const a = registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    server.broadcast(a);
    const b = registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "cmux", cwd: "/repo2", bootId: "B1", seq: 2, occurredAtMs: 2 });
    server.broadcast(b);

    const upsertedLogs = logs.filter((l) => l.includes("workspace.upserted"));
    expect(upsertedLogs.length).toBe(1); // deduped to one alias identity
    expect(upsertedLogs[0]).toContain("cmux");
  });

  test("activating either member logs the SAME alias id both times", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "title", createGroups: "eager" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "cmux", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });

    const selA = registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 3, occurredAtMs: 3 });
    server.broadcast(selA);
    const selB = registry.applyEvent({ name: "selected", workspaceId: "SRC-B", title: "cmux", cwd: "/b", bootId: "B1", seq: 4, occurredAtMs: 4 });
    server.broadcast(selB);

    const activatedLines = logs.filter((l) => l.includes("workspace.activated"));
    expect(activatedLines.length).toBe(2);
    const idOf = (line: string) => line.match(/\((t_[0-9a-f]{8})\)/)?.[1];
    expect(idOf(activatedLines[0]!)).toBe(idOf(activatedLines[1]!));
  });
});

describe("ActuatorServer.broadcast -- groupBy: workspace (unchanged behavior)", () => {
  test("two same-title workspaces upserting each log their own real id", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    const a = registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/repo", bootId: "B1", seq: 1, occurredAtMs: 1 });
    server.broadcast(a);
    const b = registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "cmux", cwd: "/repo2", bootId: "B1", seq: 2, occurredAtMs: 2 });
    server.broadcast(b);

    const upsertedLogs = logs.filter((l) => l.includes("workspace.upserted"));
    expect(upsertedLogs.length).toBe(2); // no aliasing -- one per real workspace
  });
});

describe("ActuatorServer -- createGroups: on-activate (legacy 'lazy' semantics)", () => {
  test("an upserted event for a never-activated identity is suppressed until it's attached", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-activate" }), registry);

    const created = registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    server.broadcast(created);
    expect(logs.some((l) => l.includes("workspace.upserted"))).toBe(false); // never active/attached -- suppressed

    const selected = registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 2, occurredAtMs: 2 });
    server.broadcast(selected);
    expect(logs.some((l) => l.includes("workspace.activated"))).toBe(true); // activated always passes
    // on-activate: selected also attaches, via registry's default attachOnActivate: true.
    expect(logs.some((l) => l.includes("workspace.upserted"))).toBe(false); // no unrelated title/cwd change to re-upsert
  });

  test("getState's projected view only includes active/attached identities in on-activate mode", () => {
    const registry = new Registry();
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-activate" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "attached-one", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "never-attached", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });
    const sel = registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "attached-one", cwd: "/a", bootId: "B1", seq: 3, occurredAtMs: 3 });
    server.broadcast(sel);

    const state = server.getState();
    expect(state.workspaces.length).toBe(2); // raw view: full fidelity, unaffected by lazy
    expect(state.projected.workspaces.length).toBe(1); // projected view: only the attached one
    expect(state.projected.workspaces[0]!.title).toBe("attached-one");
  });

  test("eager mode includes everything in the projected view regardless of attachment", () => {
    const registry = new Registry();
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "a", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "b", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });

    const state = server.getState();
    expect(state.projected.workspaces.length).toBe(2);
  });

  test("open_url attaches its target -- a subsequent upsert for it is no longer suppressed", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-activate" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const ref = [...registry.workspaces.values()][0]!;
    server.pushOpenUrl(ref, "https://example.test");
    expect(logs.some((l) => l.includes("open_url"))).toBe(true);

    // a later unrelated re-upsert of the same workspace should now pass through (attached)
    const renamed = registry.applyEvent({ name: "renamed", workspaceId: "SRC-A", title: "renamed-x", cwd: "/a", bootId: "B1", seq: 2, occurredAtMs: 2 });
    server.broadcast(renamed);
    expect(logs.some((l) => l.includes("workspace.upserted") && l.includes("renamed-x"))).toBe(true);
  });
});

describe("ActuatorServer -- createGroups: on-open (default)", () => {
  // main.ts sets registry.attachOnActivate = config.createGroups !== "on-open"
  // right after construction; these tests reproduce that wiring explicitly
  // since they drive the registry directly, bypassing main.ts.
  function makeOnOpenRegistry(): Registry {
    const registry = new Registry();
    registry.attachOnActivate = false;
    return registry;
  }

  test("selecting a never-opened workspace activates but its group stays excluded from the projected view", () => {
    const registry = makeOnOpenRegistry();
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-open" }), registry);

    const sel = registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    server.broadcast(sel);

    const state = server.getState();
    expect(state.activeId).not.toBeNull(); // raw activeId is still accurate
    expect(state.projected.activeId).not.toBeNull();
    expect(state.projected.workspaces.length).toBe(0); // but no group for it yet
  });

  test("a brand-new workspace's FIRST selection (upserted+activated in one batch) does not leak an upserted event", () => {
    const registry = makeOnOpenRegistry();
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-open" }), registry);

    // "selected" on a workspace the registry has never seen produces BOTH
    // workspace.upserted (changed: true, brand new) and workspace.activated
    // in the SAME applyEvent call -- exactly the batch-ordering case that
    // used to leak an empty placeholder group through the activeId shortcut.
    const sel = registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    server.broadcast(sel);

    expect(logs.some((l) => l.includes("workspace.upserted"))).toBe(false);
    expect(logs.some((l) => l.includes("workspace.activated"))).toBe(true);
  });

  test("open_url is the only thing that attaches -- afterward the group appears in the projected view", () => {
    const registry = makeOnOpenRegistry();
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-open" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const ref = [...registry.workspaces.values()][0]!;
    server.pushOpenUrl(ref, "https://example.test");

    const state = server.getState();
    expect(state.projected.workspaces.length).toBe(1);
    expect(state.projected.workspaces[0]!.title).toBe("x");
  });

  test("window follow (activateBySourceId) also does not attach", () => {
    const registry = makeOnOpenRegistry();
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "on-open" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const followed = registry.activateBySourceId("SRC-A");
    server.broadcast(followed);

    const state = server.getState();
    expect(state.projected.activeId).not.toBeNull();
    expect(state.projected.workspaces.length).toBe(0);
  });
});


describe("ActuatorServer.getState -- raw and projected views", () => {
  test("raw workspaces always include every real ref regardless of groupBy/createGroups", () => {
    const registry = new Registry();
    const { server } = makeServer(cfg({ groupBy: "title", createGroups: "on-activate" }), registry);
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "cmux", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });

    const state = server.getState();
    expect(state.workspaces.length).toBe(2);
    expect(state.projected.groupBy).toBe("title");
    expect(state.projected.createGroups).toBe("on-activate");
  });
});

describe("ActuatorServer.pushOpenUrl -- groupBy: title routes to the alias", () => {
  test("open_url targeting one member logs the shared alias id", () => {
    const registry = new Registry();
    const { server, logs } = makeServer(cfg({ groupBy: "title", createGroups: "eager" }), registry);

    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "cmux", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });
    const memberA = [...registry.workspaces.values()].find((r) => r.sourceId === "SRC-A")!;

    const identity = server.pushOpenUrl(memberA, "https://example.test");
    expect(identity.id).toMatch(/^t_[0-9a-f]{8}$/);
    expect(logs.some((l) => l.includes("open_url") && l.includes(identity.id))).toBe(true);
  });
});
