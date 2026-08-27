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

  // createGroups: "on-open" (docs/protocol.md, "Extension behavior"): the
  // daemon does not filter out activation of a never-attached identity --
  // this is safe only because activation alone never emits ensureGroup
  // (only workspace.upserted/openUrl do), so chrome-ops's activate() is
  // always a no-op for it (groupId stays null). New identity or existing,
  // with or without collapseOthers -- never ensureGroup.
  test("never emits ensureGroup, even for an identity never seen before", () => {
    const state = makeState({ config: { collapseOthers: true, closeBehavior: "archive" } });
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_never_opened", title: "alpha", color: "blue" },
    });
    expect(ops.find((o) => o.op === "ensureGroup")).toBeUndefined();
  });

  test("a brand-new identity's byId entry starts with groupId: null (activate() then no-ops on it)", () => {
    const state = makeState();
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_never_opened", title: "alpha", color: "blue" },
    });
    expect(next.byId.mw_never_opened.groupId).toBeNull();
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

  test("does not mutate activeId", () => {
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

  // createGroups: "on-open" -- open_url is often the FIRST time an
  // identity ever reaches the extension (attachment happens only via
  // open_url, so nothing upserted it first). Without a byId entry,
  // chrome-ops's openUrl would have nothing to create the group around.
  test("establishes a byId entry for a target never seen before, with groupId: null", () => {
    const state = makeState();
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
    });
    expect(next.byId.mw_a).toEqual({
      title: "alpha",
      color: "blue",
      archived: false,
      groupId: null,
      lastActiveTabId: null,
      ports: [],
    });
  });

  test("preserves an existing entry's groupId/lastActiveTabId/ports instead of overwriting them", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 7, lastActiveTabId: 3, ports: [4000] } },
    });
    const { state: next } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
    });
    expect(next.byId.mw_a).toEqual({ title: "alpha", color: "blue", archived: false, groupId: 7, lastActiveTabId: 3, ports: [4000] });
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

describe("tab group janitor", () => {
  test("a canonical group (matches the cached groupId) is left untouched", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [{ tabId: 1, url: "https://example.com" }] }],
    });
    expect(ops.find((o) => o.op === "mergeGroup" || o.op === "closeGroup" || o.op === "reportForeignGroups")).toBeUndefined();
  });

  test("a duplicate group merges into the cached canonical group", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [
        { groupId: 10, title: "alpha", tabs: [{ tabId: 1, url: "https://example.com" }] },
        { groupId: 11, title: "alpha", tabs: [{ tabId: 2, url: "chrome://newtab/" }] },
      ],
    });
    expect(ops).toContainEqual({ op: "mergeGroup", fromGroupId: 11, intoId: 10 });
    expect(ops.find((o) => o.op === "mergeGroup" && o.fromGroupId === 10)).toBeUndefined();
  });

  test("multiple duplicates for the same title all merge into the one canonical group", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [
        { groupId: 10, title: "alpha", tabs: [] },
        { groupId: 11, title: "alpha", tabs: [] },
        { groupId: 12, title: "alpha", tabs: [] },
      ],
    });
    const merges = ops.filter((o) => o.op === "mergeGroup");
    expect(merges).toEqual([
      { op: "mergeGroup", fromGroupId: 11, intoId: 10 },
      { op: "mergeGroup", fromGroupId: 12, intoId: 10 },
    ]);
  });

  test("with no cached groupId, the first scan-order match becomes canonical and later ones merge into it", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [
        { groupId: 20, title: "alpha", tabs: [] },
        { groupId: 21, title: "alpha", tabs: [] },
      ],
    });
    expect(ops).toContainEqual({ op: "mergeGroup", fromGroupId: 21, intoId: 20 });
    expect(ops.find((o) => o.op === "mergeGroup" && o.fromGroupId === 20)).toBeUndefined();
  });

  test("a blank orphan (unmanaged title, only new-tab/blank placeholder tabs) closes", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [
        {
          groupId: 30,
          title: "orphan-from-eager-era",
          tabs: [
            { tabId: 5, url: "chrome://newtab/" },
            { tabId: 6, url: "about:blank" },
          ],
        },
      ],
    });
    expect(ops).toContainEqual({ op: "closeGroup", groupId: 30 });
  });

  test("a foreign group (unmanaged title, real tabs) is reported, never merged or closed", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [
        { groupId: 40, title: "personal banking", tabs: [{ tabId: 7, url: "https://bank.example.com" }] },
      ],
    });
    expect(ops).toContainEqual({ op: "reportForeignGroups", groups: [{ title: "personal banking", tabCount: 1 }] });
    expect(ops.find((o) => o.op === "mergeGroup" || o.op === "closeGroup")).toBeUndefined();
  });

  test("multiple foreign groups batch into a single reportForeignGroups op", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [
        { groupId: 40, title: "banking", tabs: [{ tabId: 7, url: "https://bank.example.com" }] },
        { groupId: 41, title: "email", tabs: [{ tabId: 8, url: "https://mail.example.com" }] },
      ],
    });
    expect(ops.filter((o) => o.op === "reportForeignGroups")).toHaveLength(1);
    expect(ops).toContainEqual({
      op: "reportForeignGroups",
      groups: [
        { title: "banking", tabCount: 1 },
        { title: "email", tabCount: 1 },
      ],
    });
  });

  test("config.janitor: false disables the pass entirely, even with a real duplicate present", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive", janitor: false },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [
        { groupId: 10, title: "alpha", tabs: [] },
        { groupId: 11, title: "alpha", tabs: [] },
      ],
    });
    expect(ops.find((o) => o.op === "mergeGroup" || o.op === "closeGroup" || o.op === "reportForeignGroups")).toBeUndefined();
  });

  test("an archived identity's title still counts as managed -- its duplicate still merges", () => {
    const state = makeState({
      byId: { mw_b: { title: "beta", color: "red", archived: true, groupId: 50, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_b", title: "beta", color: "red", archived: true }] },
      janitorGroups: [
        { groupId: 50, title: "beta", tabs: [] },
        { groupId: 51, title: "beta", tabs: [{ tabId: 9, url: "chrome://newtab/" }] },
      ],
    });
    expect(ops).toContainEqual({ op: "mergeGroup", fromGroupId: 51, intoId: 50 });
  });

  test("janitor ops are ordered before ensureGroup ops so a stale duplicate can't win the re-query", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 30, title: "blank-orphan", tabs: [{ tabId: 1, url: "about:blank" }] }],
    });
    const closeIndex = ops.findIndex((o) => o.op === "closeGroup");
    const ensureIndex = ops.findIndex((o) => o.op === "ensureGroup");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(ensureIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(ensureIndex);
  });

  test("no janitorGroups on the sync message means the pass is skipped (idempotent no-op)", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
    });
    expect(ops.find((o) => o.op === "mergeGroup" || o.op === "closeGroup" || o.op === "reportForeignGroups")).toBeUndefined();
  });

  // Interplay with createGroups: "on-open" (point 5 of the on-open task):
  // the janitor can only ever classify a scanned group as CANONICAL/
  // DUPLICATE against a title present in byId -- and in on-open mode, byId
  // only ever holds identities the client has actually seen (attached via
  // open_url, or transiently via a bare activation -- see
  // "workspace.activated" tests above). Nothing is ever resurrected: a
  // title truly absent from byId (never attached, never even activated
  // this session) is orphan/foreign, dissolved like any other leftover.
  test("a blank group whose title is absent from byId (never attached) is a BLANK ORPHAN, not resurrected", () => {
    const state = makeState(); // empty byId -- nothing ever attached or activated
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [{ groupId: 30, title: "never-attached", tabs: [{ tabId: 1, url: "chrome://newtab/" }] }],
    });
    expect(ops).toContainEqual({ op: "closeGroup", groupId: 30 });
  });

  // The one wrinkle: a BARE activation (never open_url'd) still creates a
  // byId entry with groupId: null (see "workspace.activated" tests). If a
  // leftover blank group with that same title already exists in Chrome, it
  // now classifies as CANONICAL (first title-match) instead of BLANK
  // ORPHAN, and the janitor leaves it alone -- weakening point 5's cleanup
  // guarantee for that one title until either it's actually opened or the
  // group is closed by hand. Not a resurrection (nothing is created), but
  // documented here since it's a real, order-dependent gap.
  test("a blank group whose title IS present in byId (via a bare activation) is shielded from cleanup", () => {
    const state = makeState({
      byId: { mw_a: { title: "activated-not-opened", color: "blue", archived: false, groupId: null, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [{ groupId: 31, title: "activated-not-opened", tabs: [{ tabId: 2, url: "chrome://newtab/" }] }],
    });
    expect(ops.find((o) => o.op === "closeGroup" || o.op === "mergeGroup")).toBeUndefined();
  });
});
