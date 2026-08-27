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

function makeServer(
  config: MetamuxConfig,
  registry: Registry,
  callbacks: { onGroupPlacement?: (id: string, chromeWindowId: string | null) => void; onWindowPairing?: (cmuxWindowId: string, chromeWindowId: string) => void } = {},
) {
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
    ...callbacks,
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

describe("ActuatorServer.handlePrune (POST /prune)", () => {
  // handlePrune is private; constructing a real Request and invoking it
  // via a bracket-notation cast is the minimal way to exercise the actual
  // endpoint logic (auth, JSON parsing, the onPrune/pushSyncToAll
  // conditionals) without starting a real server on a real port -- the
  // file's own established convention (see the top comment).
  function makeServerWithPrune(config: MetamuxConfig, registry: Registry, onPrune?: () => void) {
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
      onPrune,
      log: (line) => logs.push(line),
    });
    return { server, logs };
  }

  function callPrune(server: ActuatorServer, token: string): Promise<Response> {
    const req = new Request("http://127.0.0.1/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return (server as unknown as { handlePrune(req: Request): Promise<Response> }).handlePrune(req);
  }

  test("removes archived refs and reports them by id/title", async () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "gone", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "closed", workspaceId: "SRC-A", title: "gone", cwd: "/a", bootId: "B1", seq: 2, occurredAtMs: 2 });
    const { server } = makeServerWithPrune(cfg(), registry);

    const res = await callPrune(server, "test-secret");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.removed.length).toBe(1);
    expect(body.removed[0].title).toBe("gone");
    expect(registry.workspaces.size).toBe(0);
  });

  test("live refs are never removed", async () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "live", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const { server } = makeServerWithPrune(cfg(), registry);

    const res = await callPrune(server, "test-secret");
    const body = await res.json();
    expect(body.removed).toEqual([]);
    expect(registry.workspaces.size).toBe(1);
  });

  test("rejects a missing/wrong token with 401", async () => {
    const registry = new Registry();
    const { server } = makeServerWithPrune(cfg(), registry);
    const res = await callPrune(server, "wrong-token");
    expect(res.status).toBe(401);
  });

  test("calls onPrune (persist) only when something was actually removed", async () => {
    let pruneCalls = 0;
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "live", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const { server } = makeServerWithPrune(cfg(), registry, () => {
      pruneCalls++;
    });

    await callPrune(server, "test-secret");
    expect(pruneCalls).toBe(0); // nothing archived -- nothing to persist

    registry.applyEvent({ name: "created", workspaceId: "SRC-B", title: "gone", cwd: "/b", bootId: "B1", seq: 2, occurredAtMs: 2 });
    registry.applyEvent({ name: "closed", workspaceId: "SRC-B", title: "gone", cwd: "/b", bootId: "B1", seq: 3, occurredAtMs: 3 });
    await callPrune(server, "test-secret");
    expect(pruneCalls).toBe(1);
  });
});

describe("ActuatorServer.handleAutomation (POST /automation)", () => {
  // Same private-method-cast convention as handlePrune above. No extension
  // socket is ever connected in these tests (no real WS), so only the
  // early-exit paths (auth, op validation, the agentBrowser gate, no-target,
  // no-extension) are reachable here -- the full round-trip through a real
  // extension response is the isolated e2e's job.
  function callAutomation(server: ActuatorServer, body: Record<string, unknown>): Promise<Response> {
    const req = new Request("http://127.0.0.1/automation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (server as unknown as { handleAutomation(req: Request): Promise<Response> }).handleAutomation(req);
  }

  function registryWithActive(): Registry {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyEvent({ name: "selected", workspaceId: "SRC-A", title: "cmux", cwd: "/a", bootId: "B1", seq: 2, occurredAtMs: 2 });
    return registry;
  }

  test("rejects a missing/wrong token with 401", async () => {
    const { server } = makeServer(cfg(), registryWithActive());
    const res = await callAutomation(server, { token: "wrong", op: { kind: "tabContext" } });
    expect(res.status).toBe(401);
  });

  test("rejects a missing op.kind with 400", async () => {
    const { server } = makeServer(cfg(), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: {} });
    expect(res.status).toBe(400);
  });

  test("agentBrowser: off refuses every op with 403", async () => {
    const { server } = makeServer(cfg({ agentBrowser: "off" }), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "tabContext" } });
    expect(res.status).toBe(403);
  });

  test("agentBrowser: read refuses a write op (navigate) with 403", async () => {
    const { server } = makeServer(cfg({ agentBrowser: "read" }), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "navigate", url: "https://example.com" } });
    expect(res.status).toBe(403);
  });

  test("agentBrowser: read allows a read op through to the next check (no extension -- 503, not 403)", async () => {
    const { server } = makeServer(cfg({ agentBrowser: "read" }), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "tabContext" } });
    expect(res.status).toBe(503);
  });

  test("no active/matching target workspace -- 404", async () => {
    const { server } = makeServer(cfg(), new Registry());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "tabContext" } });
    expect(res.status).toBe(404);
  });

  test("an unknown explicit workspaceId -- 404, not silently falling back to active", async () => {
    const { server } = makeServer(cfg(), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", workspaceId: "mw_unknown", op: { kind: "tabContext" } });
    expect(res.status).toBe(404);
  });

  test("no extension connected -- 503, a distinct immediate error", async () => {
    const { server } = makeServer(cfg(), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "tabContext" } });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/no extension connected/);
  });

  test("a navigate op to a blocked (private-range) URL is refused with 403 before ever reaching the extension-connected check", async () => {
    const { server } = makeServer(cfg({ agentBrowser: "full" }), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "navigate", url: "http://10.0.0.5/" } });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/navigate blocked/);
  });

  test("a navigate op with a missing op.url is a 400, not a DNS lookup attempt", async () => {
    const { server } = makeServer(cfg({ agentBrowser: "full" }), registryWithActive());
    const res = await callAutomation(server, { token: "test-secret", op: { kind: "navigate" } });
    expect(res.status).toBe(400);
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

describe("ActuatorServer -- window pairing (docs/protocol.md, 'Window pairing')", () => {
  test("getState's raw view carries a tmux-sourced ref's cmuxWindowId/placementOverride natively (full-fidelity WorkspaceRef fields)", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-1" });
    const { server } = makeServer(cfg({ groupBy: "workspace" }), registry);

    const state = server.getState();
    expect(state.workspaces[0]!.cmuxWindowId).toBe("win-1");
    expect(state.workspaces[0]!.placementOverride).toBeNull();
  });

  test("getState's projected view resolves homeChromeWindowId AND cmuxWindowId from the registry", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-1" });
    registry.setWindowPairing("win-1", "chrome-win-a");
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    const state = server.getState();
    expect(state.projected.workspaces[0]!.homeChromeWindowId).toBe("chrome-win-a");
    expect(state.projected.workspaces[0]!.cmuxWindowId).toBe("win-1");
  });

  test("an unpaired cmux window resolves homeChromeWindowId to null but still reports cmuxWindowId (the uuid the extension needs to pair)", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-unpaired" });
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    const state = server.getState();
    expect(state.projected.workspaces[0]!.homeChromeWindowId).toBeNull();
    expect(state.projected.workspaces[0]!.cmuxWindowId).toBe("win-unpaired");
  });

  test("a cmux-sourced identity (no cmuxWindowId ever stamped) reports cmuxWindowId: null", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    const state = server.getState();
    expect(state.projected.workspaces[0]!.cmuxWindowId).toBeNull();
  });

  test("groupBy: title resolves homeChromeWindowId from the first live member carrying a cmuxWindowId", () => {
    const registry = new Registry();
    // A cmux-sourced sibling under the same title carries no cmuxWindowId at all.
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "compliance", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-1" });
    registry.setWindowPairing("win-1", "chrome-win-a");
    const { server } = makeServer(cfg({ groupBy: "title", createGroups: "eager" }), registry);

    const state = server.getState();
    expect(state.projected.workspaces[0]!.homeChromeWindowId).toBe("chrome-win-a");
  });

  test("placementOverride surfaces through the projected view", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const ref = [...registry.workspaces.values()][0]!;
    registry.setPlacementOverride(ref.id, "chrome-win-b");
    const { server } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);

    const state = server.getState();
    expect(state.projected.workspaces[0]!.placementOverride).toBe("chrome-win-b");
  });

  test("pushOpenUrl's broadcast event carries the target's homeChromeWindowId", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-1" });
    registry.setWindowPairing("win-1", "chrome-win-a");
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);
    const ref = [...registry.workspaces.values()][0]!;

    server.pushOpenUrl(ref, "https://example.test");
    expect(logs.some((l) => l.includes("open_url") && l.includes("[win chrome-win-a]"))).toBe(true);
  });

  test("pushOpenUrl's broadcast event carries cmuxWindowId even before a Chrome pairing exists -- this is how the extension bootstraps one", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-1" });
    // deliberately NOT calling setWindowPairing -- no pairing exists yet
    const events: Array<Record<string, unknown>> = [];
    const server = new ActuatorServer({
      port: 0,
      secret: "test-secret",
      registry,
      config: cfg({ groupBy: "workspace", createGroups: "eager" }),
      cursor: { bootId: "B1", seq: 1 },
      stats: { skippedLines: 0 },
      groupProjection: new GroupProjection("workspace"),
      lazyGroups: new LazyGroupTracker(),
      log: () => {},
    });
    (server as unknown as { broadcastRaw(event: Record<string, unknown>): void }).broadcastRaw = (event) => events.push(event);
    const ref = [...registry.workspaces.values()][0]!;

    server.pushOpenUrl(ref, "https://example.test");
    expect(events).toHaveLength(1);
    expect(events[0]!.homeChromeWindowId).toBeNull(); // no pairing yet
    expect(events[0]!.cmuxWindowId).toBe("win-1"); // but the uuid IS present -- enough to establish one
  });

  test("pushOpenUrl for an unpaired window omits the window suffix", () => {
    const registry = new Registry();
    registry.applyEvent({ name: "created", workspaceId: "SRC-A", title: "x", cwd: "/a", bootId: "B1", seq: 1, occurredAtMs: 1 });
    const { server, logs } = makeServer(cfg({ groupBy: "workspace", createGroups: "eager" }), registry);
    const ref = [...registry.workspaces.values()][0]!;

    server.pushOpenUrl(ref, "https://example.test");
    const openUrlLine = logs.find((l) => l.includes("open_url"))!;
    expect(openUrlLine).not.toContain("[win ");
  });
});

describe("ActuatorServer -- groupPlacement / windowPairing ws frames", () => {
  // handleWsMessage is private; constructing a minimal fake authed
  // ServerWebSocket and invoking it via a bracket-notation cast mirrors
  // this file's own handlePrune convention (see its comment above) --
  // the frame-parsing dispatch itself has no other test seam.
  interface FakeWs {
    data: { authed: boolean; client: string | null };
    send: (s: string) => void;
  }

  function fakeWs(): FakeWs {
    return { data: { authed: true, client: "extension" }, send: () => {} };
  }

  function sendMessage(server: ActuatorServer, payload: unknown): void {
    (server as unknown as { handleWsMessage(ws: FakeWs, message: string): void }).handleWsMessage(fakeWs(), JSON.stringify(payload));
  }

  test("groupPlacement calls onGroupPlacement with the id and chromeWindowId", () => {
    const registry = new Registry();
    const calls: Array<[string, string | null]> = [];
    const { server } = makeServer(cfg(), registry, { onGroupPlacement: (id, chromeWindowId) => calls.push([id, chromeWindowId]) });

    sendMessage(server, { type: "groupPlacement", id: "mw_abc123", chromeWindowId: "chrome-win-z" });
    expect(calls).toEqual([["mw_abc123", "chrome-win-z"]]);
  });

  test("groupPlacement with chromeWindowId: null clears the override", () => {
    const registry = new Registry();
    const calls: Array<[string, string | null]> = [];
    const { server } = makeServer(cfg(), registry, { onGroupPlacement: (id, chromeWindowId) => calls.push([id, chromeWindowId]) });

    sendMessage(server, { type: "groupPlacement", id: "mw_abc123", chromeWindowId: null });
    expect(calls).toEqual([["mw_abc123", null]]);
  });

  test("groupPlacement with no id is ignored", () => {
    const registry = new Registry();
    let called = false;
    const { server } = makeServer(cfg(), registry, { onGroupPlacement: () => (called = true) });

    sendMessage(server, { type: "groupPlacement", chromeWindowId: "chrome-win-z" });
    expect(called).toBe(false);
  });

  test("windowPairing calls onWindowPairing with both ids", () => {
    const registry = new Registry();
    const calls: Array<[string, string]> = [];
    const { server } = makeServer(cfg(), registry, { onWindowPairing: (cmuxWindowId, chromeWindowId) => calls.push([cmuxWindowId, chromeWindowId]) });

    sendMessage(server, { type: "windowPairing", cmuxWindowId: "win-1", chromeWindowId: "chrome-win-a" });
    expect(calls).toEqual([["win-1", "chrome-win-a"]]);
  });

  test("windowPairing missing either id is ignored", () => {
    const registry = new Registry();
    let called = false;
    const { server } = makeServer(cfg(), registry, { onWindowPairing: () => (called = true) });

    sendMessage(server, { type: "windowPairing", cmuxWindowId: "win-1" });
    expect(called).toBe(false);
  });
});
