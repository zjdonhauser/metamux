import { describe, test, expect } from "bun:test";
import { initialState, reduce } from "../reducer.js";

/** @param {Partial<import("../reducer.js").State>} [overrides] */
function makeState(overrides = {}) {
  return { ...initialState(), ...overrides };
}

describe("seq dedupe", () => {
  test("ignores an event with seq <= lastSeq", () => {
    const state = makeState({ lastSeq: 10 });
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 10,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "a", color: "blue" },
    });
    expect(ops).toEqual([]);
    expect(next).toBe(state);
  });

  test("ignores an event with seq well below lastSeq", () => {
    const state = makeState({ lastSeq: 50 });
    const { ops } = reduce(state, {
      type: "event",
      seq: 3,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "a", color: "blue" },
    });
    expect(ops).toEqual([]);
  });

  test("processes an event with seq > lastSeq and advances lastSeq", () => {
    const state = makeState({ lastSeq: 10 });
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 11,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "a", color: "blue" },
    });
    expect(next.lastSeq).toBe(11);
    expect(ops.length).toBeGreaterThan(0);
  });
});

describe("sync reconciliation", () => {
  test("emits ensureGroup for each unarchived workspace, skips archived", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: null,
        workspaces: [
          { id: "mw_a", title: "alpha", color: "blue", archived: false },
          { id: "mw_b", title: "beta", color: "red", archived: true },
        ],
      },
    });
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue" });
    expect(ops.find((o) => o.op === "ensureGroup" && o.id === "mw_b")).toBeUndefined();
  });

  test("emits activate for activeId", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: false, closeBehavior: "archive" },
      state: {
        activeId: "mw_a",
        workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }],
      },
    });
    expect(ops).toContainEqual({ op: "activate", id: "mw_a" });
  });

  test("emits archiveGroup for an archived workspace with a cached groupId", () => {
    const state = makeState({
      byId: { mw_b: { title: "beta", color: "red", archived: false, groupId: 6, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: null,
        workspaces: [{ id: "mw_b", title: "beta", color: "red", archived: true }],
      },
    });
    expect(ops).toContainEqual({ op: "archiveGroup", id: "mw_b", behavior: "archive" });
  });

  test("does not emit archiveGroup for an archived workspace with no cached groupId", () => {
    const state = makeState({
      byId: { mw_b: { title: "beta", color: "red", archived: false, groupId: null, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: null,
        workspaces: [{ id: "mw_b", title: "beta", color: "red", archived: true }],
      },
    });
    expect(ops.find((o) => o.op === "archiveGroup")).toBeUndefined();
  });

  test("sync sets lastSeq and stores config/byId, preserving cached groupId", () => {
    const state = makeState({
      byId: { mw_a: { title: "old", color: "blue", archived: false, groupId: 42, lastActiveTabId: 7 } },
    });
    const { state: next } = reduce(state, {
      type: "sync",
      seq: 5,
      config: { collapseOthers: true, closeBehavior: "close" },
      state: {
        activeId: "mw_a",
        workspaces: [{ id: "mw_a", title: "alpha renamed", color: "blue", archived: false }],
      },
    });
    expect(next.lastSeq).toBe(5);
    expect(next.config).toEqual({ collapseOthers: true, closeBehavior: "close" });
    expect(next.byId.mw_a.groupId).toBe(42);
    expect(next.byId.mw_a.lastActiveTabId).toBe(7);
    expect(next.byId.mw_a.title).toBe("alpha renamed");
  });
});

describe("workspace.activated", () => {
  test("emits activate and collapseOthers when config.collapseOthers is true", () => {
    const state = makeState({ config: { collapseOthers: true, closeBehavior: "archive" } });
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops).toContainEqual({ op: "activate", id: "mw_a" });
    expect(ops).toContainEqual({ op: "collapseOthers", exceptId: "mw_a" });
  });

  test("omits collapseOthers when config.collapseOthers is false", () => {
    const state = makeState({ config: { collapseOthers: false, closeBehavior: "archive" } });
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops).toContainEqual({ op: "activate", id: "mw_a" });
    expect(ops.find((o) => o.op === "collapseOthers")).toBeUndefined();
  });

  test("sets state.activeId", () => {
    const state = makeState();
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(next.activeId).toBe("mw_a");
  });
});

describe("workspace.upserted", () => {
  test("create: adds a new entry and emits ensureGroup", () => {
    const state = makeState();
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(next.byId.mw_a).toBeDefined();
    expect(next.byId.mw_a.archived).toBe(false);
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue" });
  });

  test("rename: updates title, preserves cached groupId, emits ensureGroup with new title", () => {
    const state = makeState({
      byId: { mw_a: { title: "old-name", color: "blue", archived: false, groupId: 99, lastActiveTabId: 3 } },
    });
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "new-name", color: "blue" },
    });
    expect(next.byId.mw_a.title).toBe("new-name");
    expect(next.byId.mw_a.groupId).toBe(99);
    expect(next.byId.mw_a.lastActiveTabId).toBe(3);
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "new-name", color: "blue" });
  });

  test("unarchive: clears archived flag", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: true, groupId: null, lastActiveTabId: null } },
    });
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(next.byId.mw_a.archived).toBe(false);
  });
});

describe("workspace.archived", () => {
  test("closeBehavior archive emits archiveGroup with behavior 'archive'", () => {
    const state = makeState({
      config: { collapseOthers: true, closeBehavior: "archive" },
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 5, lastActiveTabId: null } },
    });
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.archived",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops).toContainEqual({ op: "archiveGroup", id: "mw_a", behavior: "archive" });
    expect(next.byId.mw_a.archived).toBe(true);
  });

  test("closeBehavior close emits archiveGroup with behavior 'close'", () => {
    const state = makeState({
      config: { collapseOthers: true, closeBehavior: "close" },
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 5, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.archived",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops).toContainEqual({ op: "archiveGroup", id: "mw_a", behavior: "close" });
  });
});

describe("open_url", () => {
  test("routes to the target workspace via an openUrl op", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
    });
    expect(ops).toContainEqual({ op: "openUrl", id: "mw_a", url: "https://example.com" });
  });

  test("does not mutate byId or activeId", () => {
    const state = makeState({ activeId: "mw_z" });
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
    });
    expect(next.activeId).toBe("mw_z");
  });
});

describe("local facts", () => {
  test("tabActivated updates lastActiveTabId for the entry matching groupId", () => {
    const state = makeState({
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 5, lastActiveTabId: null },
        mw_b: { title: "beta", color: "red", archived: false, groupId: 6, lastActiveTabId: null },
      },
    });
    const { state: next, ops } = reduce(state, {
      type: "local",
      name: "tabActivated",
      groupId: 5,
      tabId: 123,
    });
    expect(next.byId.mw_a.lastActiveTabId).toBe(123);
    expect(next.byId.mw_b.lastActiveTabId).toBe(null);
    expect(ops).toContainEqual({ op: "saveState" });
  });

  test("tabActivated is a no-op when no entry matches groupId", () => {
    const state = makeState();
    const { state: next, ops } = reduce(state, {
      type: "local",
      name: "tabActivated",
      groupId: 999,
      tabId: 1,
    });
    expect(next).toBe(state);
    expect(ops).toEqual([]);
  });

  test("groupCreated resolves the cached groupId for an entry", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } },
    });
    const { state: next } = reduce(state, {
      type: "local",
      name: "groupCreated",
      id: "mw_a",
      groupId: 42,
    });
    expect(next.byId.mw_a.groupId).toBe(42);
  });
});

describe("focus_window", () => {
  test("emits a focusWindow op", () => {
    const state = makeState();
    const { ops } = reduce(state, { type: "event", seq: 1, name: "focus_window" });
    expect(ops).toContainEqual({ op: "focusWindow" });
  });

  test("does not touch byId or activeId", () => {
    const state = makeState({
      activeId: "mw_z",
      byId: { mw_z: { title: "z", color: "blue", archived: false, groupId: 1, lastActiveTabId: null, ports: [] } },
    });
    const { state: next } = reduce(state, { type: "event", seq: 1, name: "focus_window" });
    expect(next.activeId).toBe("mw_z");
    expect(next.byId).toEqual(state.byId);
  });

  test("advances lastSeq like any other event", () => {
    const state = makeState({ lastSeq: 5 });
    const { state: next } = reduce(state, { type: "event", seq: 6, name: "focus_window" });
    expect(next.lastSeq).toBe(6);
  });

  test("workspace.activated NEVER emits a focusWindow op", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops.find((o) => o.op === "focusWindow")).toBeUndefined();
  });

  test("sync reconciliation NEVER emits a focusWindow op", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: "mw_a",
        workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }],
      },
    });
    expect(ops.find((o) => o.op === "focusWindow")).toBeUndefined();
  });
});

describe("markServerActivation (echo-suppression signal)", () => {
  test("workspace.activated emits markServerActivation alongside activate", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(ops).toContainEqual({ op: "markServerActivation", id: "mw_a" });
  });

  test("sync reconciliation emits markServerActivation for activeId", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: false, closeBehavior: "archive" },
      state: {
        activeId: "mw_a",
        workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }],
      },
    });
    expect(ops).toContainEqual({ op: "markServerActivation", id: "mw_a" });
  });
});

describe("ports pass-through", () => {
  test("sync populates ports on each workspace entry", () => {
    const state = makeState();
    const { state: next } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: null,
        workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false, ports: [3000, 5173] }],
      },
    });
    expect(next.byId.mw_a.ports).toEqual([3000, 5173]);
  });

  test("sync defaults ports to [] when omitted", () => {
    const state = makeState();
    const { state: next } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: null,
        workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }],
      },
    });
    expect(next.byId.mw_a.ports).toEqual([]);
  });

  test("workspace.upserted with ports updates an existing entry's ports", () => {
    const state = makeState({
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null, ports: [3000] },
      },
    });
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "alpha", color: "blue", ports: [3000, 4000] },
    });
    expect(next.byId.mw_a.ports).toEqual([3000, 4000]);
  });

  test("workspace.upserted without ports preserves the existing entry's ports", () => {
    const state = makeState({
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null, ports: [3000] },
      },
    });
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.upserted",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
    });
    expect(next.byId.mw_a.ports).toEqual([3000]);
  });
});
