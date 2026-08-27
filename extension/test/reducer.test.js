import { describe, test, expect } from "bun:test";
import { initialState, reduce, resolveGroupCache, chooseAdoptionWindow, targetWindowFor } from "../reducer.js";

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
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue", windowId: null, cmuxWindowId: null });
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

describe("sync-authoritative byId (pruning)", () => {
  test("an id absent from the sync's workspaces list is pruned from byId", () => {
    const state = makeState({
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null },
        mw_stale: { title: "gone-tmux-session", color: "grey", archived: false, groupId: 99, lastActiveTabId: null },
      },
    });
    const { state: next } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
    });
    expect(next.byId.mw_a).toBeDefined();
    expect(next.byId.mw_stale).toBeUndefined();
  });

  test("every id present in the sync survives, none pruned", () => {
    const state = makeState({
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null },
        mw_b: { title: "beta", color: "red", archived: true, groupId: null, lastActiveTabId: null },
      },
    });
    const { state: next } = reduce(state, {
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
    expect(Object.keys(next.byId).sort()).toEqual(["mw_a", "mw_b"]);
  });

  test("an empty sync workspaces list prunes everything", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null } },
    });
    const { state: next } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
    });
    expect(next.byId).toEqual({});
  });

  test("ordering: the janitor still recognizes a stale identity's title on its LAST sync, before it's pruned", () => {
    // mw_stale is about to be pruned (absent from this sync's workspaces),
    // but its title still has two real chrome groups -- the janitor must
    // see it as a managed title (canonical + duplicate) THIS ONE LAST TIME
    // and merge them, not treat the duplicate as an unrecognized orphan.
    const state = makeState({
      byId: { mw_stale: { title: "old-session", color: "grey", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { state: next, ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
      janitorGroups: [
        { groupId: 10, title: "old-session", tabs: [] },
        { groupId: 11, title: "old-session", tabs: [] },
      ],
    });
    expect(ops).toContainEqual({ op: "mergeGroup", fromGroupId: 11, intoId: 10 });
    expect(next.byId.mw_stale).toBeUndefined(); // still pruned in the same reduce call
  });

  test("re-appearance: an id pruned on one sync comes back with fresh defaults if a later sync includes it again", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 1, lastActiveTabId: null } },
    });
    const pruned = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [] },
    });
    expect(pruned.state.byId.mw_a).toBeUndefined();

    const reappeared = reduce(pruned.state, {
      type: "sync",
      seq: 2,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
    });
    expect(reappeared.state.byId.mw_a).toBeDefined();
    expect(reappeared.ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue", windowId: null, cmuxWindowId: null });
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
    expect(ops).toContainEqual({ op: "collapseOthers", exceptId: "mw_a", windowId: null });
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
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue", windowId: null, cmuxWindowId: null });
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
    expect(ops).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "new-name", color: "blue", windowId: null, cmuxWindowId: null });
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
    expect(ops).toContainEqual({ op: "openUrl", id: "mw_a", url: "https://example.com", windowId: null, cmuxWindowId: null });
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
      cmuxWindowId: null,
      homeChromeWindowId: null,
      placementOverride: null,
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
    expect(next.byId.mw_a).toEqual({
      title: "alpha",
      color: "blue",
      archived: false,
      groupId: 7,
      lastActiveTabId: 3,
      ports: [4000],
      cmuxWindowId: null,
      homeChromeWindowId: null,
      placementOverride: null,
    });
  });

  test("open_url refreshes window-pairing fields on an EXISTING entry -- the daemon may resolve a pairing after the fact", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 7, lastActiveTabId: 3, ports: [], cmuxWindowId: null, homeChromeWindowId: null, placementOverride: null } },
    });
    const { state: next, ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
      cmuxWindowId: "win-1",
      homeChromeWindowId: "555",
    });
    expect(next.byId.mw_a.cmuxWindowId).toBe("win-1");
    expect(next.byId.mw_a.homeChromeWindowId).toBe("555");
    expect(ops).toContainEqual({ op: "openUrl", id: "mw_a", url: "https://example.com", windowId: 555, cmuxWindowId: "win-1" });
  });

  test("open_url with no window fields on the message carries an existing entry's pairing forward unchanged", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 7, lastActiveTabId: 3, ports: [], cmuxWindowId: "win-1", homeChromeWindowId: "555", placementOverride: null } },
    });
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
    });
    expect(ops).toContainEqual({ op: "openUrl", id: "mw_a", url: "https://example.com", windowId: 555, cmuxWindowId: "win-1" });
  });

  test("open_url for a paired-but-not-yet-resolved window (cmuxWindowId set, homeChromeWindowId null) targets windowId: null with cmuxWindowId set -- chrome-ops creates the pairing on demand", () => {
    const state = makeState();
    const { ops } = reduce(state, {
      type: "event",
      seq: 1,
      name: "open_url",
      workspace: { id: "mw_a", title: "alpha", color: "blue" },
      url: "https://example.com",
      cmuxWindowId: "win-1",
      homeChromeWindowId: null,
    });
    expect(ops).toContainEqual({ op: "openUrl", id: "mw_a", url: "https://example.com", windowId: null, cmuxWindowId: "win-1" });
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

describe("tab group janitor -- cross-window recovery", () => {
  test("a managed-title group in another window recovers into the in-window canonical", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      foreignJanitorGroups: [{ groupId: 99, windowId: 999, title: "alpha" }],
    });
    expect(ops).toContainEqual({ op: "recoverCrossWindow", fromGroupId: 99, fromWindowId: 999, intoId: 10 });
  });

  test("a foreign (unmanaged-title) group in another window is never touched", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      foreignJanitorGroups: [{ groupId: 99, windowId: 999, title: "personal banking" }],
    });
    expect(ops.find((o) => o.op === "recoverCrossWindow")).toBeUndefined();
  });

  test("a managed title with no in-window canonical yet is left for a later sync (self-healing, not a special case)", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [], // no in-window group for "alpha" yet
      foreignJanitorGroups: [{ groupId: 99, windowId: 999, title: "alpha" }],
    });
    expect(ops.find((o) => o.op === "recoverCrossWindow")).toBeUndefined();
  });

  test("config.janitorCrossWindow: false disables recovery even with a clear match", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive", janitorCrossWindow: false },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      foreignJanitorGroups: [{ groupId: 99, windowId: 999, title: "alpha" }],
    });
    expect(ops.find((o) => o.op === "recoverCrossWindow")).toBeUndefined();
  });

  test("a title with an active placementOverride is SKIPPED by cross-window recovery -- its 'foreign' window IS its home now (docs/protocol.md, 'Placement ownership')", () => {
    const state = makeState({
      byId: {
        mw_a: {
          title: "alpha",
          color: "blue",
          archived: false,
          groupId: 20,
          lastActiveTabId: null,
          cmuxWindowId: null,
          homeChromeWindowId: null,
          placementOverride: "999", // window 999 IS home now
        },
      },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }], // a leftover in the LEGACY window
      foreignJanitorGroups: [{ groupId: 20, windowId: 999, title: "alpha" }], // the real, overridden home
    });
    expect(ops.find((o) => o.op === "recoverCrossWindow")).toBeUndefined();
  });

  test("janitorCrossWindow defaults to enabled when absent from config", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" }, // no janitorCrossWindow key
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      foreignJanitorGroups: [{ groupId: 99, windowId: 999, title: "alpha" }],
    });
    expect(ops).toContainEqual({ op: "recoverCrossWindow", fromGroupId: 99, fromWindowId: 999, intoId: 10 });
  });

  test("no foreignJanitorGroups on the sync message is a no-op, not a throw", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      // foreignJanitorGroups absent entirely
    });
    expect(ops.find((o) => o.op === "recoverCrossWindow")).toBeUndefined();
  });

  test("multiple foreign-window duplicates of the same title all recover into the one in-window canonical", () => {
    const state = makeState({
      byId: { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } },
    });
    const { ops } = reduce(state, {
      type: "sync",
      seq: 1,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: { activeId: null, workspaces: [{ id: "mw_a", title: "alpha", color: "blue", archived: false }] },
      janitorGroups: [{ groupId: 10, title: "alpha", tabs: [] }],
      foreignJanitorGroups: [
        { groupId: 98, windowId: 998, title: "alpha" },
        { groupId: 99, windowId: 999, title: "alpha" },
      ],
    });
    const recoveries = ops.filter((o) => o.op === "recoverCrossWindow");
    expect(recoveries).toEqual([
      { op: "recoverCrossWindow", fromGroupId: 98, fromWindowId: 998, intoId: 10 },
      { op: "recoverCrossWindow", fromGroupId: 99, fromWindowId: 999, intoId: 10 },
    ]);
  });
});

describe("resolveGroupCache -- cache invalidation + placement following (docs/protocol.md, 'Placement ownership')", () => {
  // 2026-08-27 evening, follow-up round: resolveGroupCache's philosophy
  // changed from "a stale cross-window groupId is invalid, null it and
  // rebuild in the resolved window" to "a group that still exists is
  // authoritative wherever it is -- follow it (placementObserved), never
  // fight it." This is the direct fix for the live incident Zac hit: he
  // moved a paired window's groups to another Chrome window by hand and
  // auto-switching stopped (the OLD invalidation nulled their groupIds
  // the moment window resolution next ran).
  test("a cached groupId that still belongs to the target window is left alone (no correction)", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } };
    const allGroups = [{ groupId: 10, windowId: 1, title: "alpha" }];
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([]);
  });

  test("a cached groupId that still EXISTS but now lives in a different window is followed, not invalidated", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } };
    // groupId 10 (still our tracked group) moved to window 2; window 1
    // separately has an unrelated same-titled group under a different id
    // -- irrelevant here, the cached id is authoritative once it's found
    // to still exist at all (a genuine same-title duplicate spanning
    // windows is a known, out-of-scope edge case -- see BUILD-STATUS.md).
    const allGroups = [
      { groupId: 10, windowId: 2, title: "alpha" },
      { groupId: 20, windowId: 1, title: "alpha" },
    ];
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 2 },
    ]);
  });

  test("a cached groupId in a different window with NO matching title at target is still followed, not nulled", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } };
    const allGroups = [{ groupId: 10, windowId: 2, title: "alpha" }]; // nothing at all in window 1
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 2 },
    ]);
  });

  test("a cached groupId that no longer exists anywhere ANY window falls back to title re-resolution at the target window", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null } };
    const allGroups = [{ groupId: 20, windowId: 1, title: "alpha" }]; // groupId 10 doesn't appear at all
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([
      { type: "local", name: "groupCreated", id: "mw_a", groupId: 20 },
    ]);
  });

  test("a never-attached entry (groupId: null) with a real match at the target window resolves it, no override", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } };
    const allGroups = [{ groupId: 20, windowId: 1, title: "alpha" }];
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([
      { type: "local", name: "groupCreated", id: "mw_a", groupId: 20 },
    ]);
  });

  test("adopt reality (fresh-boot rule): a never-attached entry whose only match is OUTSIDE the target window gets both the id AND an override -- never an attempt to move it", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } };
    const allGroups = [{ groupId: 20, windowId: 2, title: "alpha" }]; // only match is window 2, not target window 1
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([
      { type: "local", name: "groupCreated", id: "mw_a", groupId: 20 },
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 2 },
    ]);
  });

  test("archived entries are never touched, even with a real group living in a different window", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: true, groupId: 10, lastActiveTabId: null } };
    const allGroups = [{ groupId: 10, windowId: 2, title: "alpha" }];
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([]);
  });

  test("an entry already carrying a placementOverride resolves against ITS override window, not state.windowId", () => {
    const byId = {
      mw_a: {
        title: "alpha",
        color: "blue",
        archived: false,
        groupId: 10,
        lastActiveTabId: null,
        cmuxWindowId: null,
        homeChromeWindowId: null,
        placementOverride: "2",
      },
    };
    // groupId 10 lives exactly at the override window (2) -- no drift, no new fact.
    const allGroups = [{ groupId: 10, windowId: 2, title: "alpha" }];
    expect(resolveGroupCache(byId, makeState({ windowId: 1 }), allGroups)).toEqual([]);
  });

  test("this is the fix for the reported live incident: groups moved to another Chrome window are followed there, not orphaned", () => {
    // The exact shape of the reported bug: byId's cached groupIds now live
    // in a window OTHER than state.windowId (the user dragged them there
    // by hand). Both are still real, live groups -- resolveGroupCache
    // must record where they actually are, never null them out.
    const byId = {
      mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: null },
      mw_b: { title: "beta", color: "red", archived: false, groupId: 11, lastActiveTabId: null },
    };
    const allGroups = [
      { groupId: 10, windowId: 777, title: "alpha" }, // moved by hand to window 777
      { groupId: 11, windowId: 777, title: "beta" }, // moved by hand to window 777
    ];
    const facts = resolveGroupCache(byId, makeState({ windowId: 555 }), allGroups);
    expect(facts).toEqual([
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 777 },
      { type: "local", name: "placementObserved", id: "mw_b", chromeWindowId: 777 },
    ]);
  });
});

describe("targetWindowFor -- window pairing resolution (docs/protocol.md, 'Window pairing')", () => {
  function entry(overrides = {}) {
    return {
      title: "x",
      color: "blue",
      archived: false,
      groupId: null,
      lastActiveTabId: null,
      ports: [],
      cmuxWindowId: null,
      homeChromeWindowId: null,
      placementOverride: null,
      ...overrides,
    };
  }

  test("null-safety: an entry with no pairing at all resolves to the legacy single metamux window -- the entire feature is a no-op for it", () => {
    const state = makeState({ windowId: 42 });
    expect(targetWindowFor(entry(), state)).toBe(42);
  });

  test("null-safety: still resolves to null when state.windowId itself is null (not yet booted)", () => {
    const state = makeState({ windowId: null });
    expect(targetWindowFor(entry(), state)).toBeNull();
  });

  test("a resolved home window wins over the legacy metamux window", () => {
    const state = makeState({ windowId: 42 });
    expect(targetWindowFor(entry({ homeChromeWindowId: "555" }), state)).toBe(555);
  });

  test("an explicit placementOverride wins over the resolved home window", () => {
    const state = makeState({ windowId: 42 });
    expect(targetWindowFor(entry({ homeChromeWindowId: "555", placementOverride: "999" }), state)).toBe(999);
  });

  test("an explicit placementOverride wins even with no home window resolved yet", () => {
    const state = makeState({ windowId: 42 });
    expect(targetWindowFor(entry({ placementOverride: "999" }), state)).toBe(999);
  });

  test("cmuxWindowId alone (no homeChromeWindowId yet -- not yet paired) does NOT affect resolution -- only homeChromeWindowId/placementOverride do", () => {
    const state = makeState({ windowId: 42 });
    expect(targetWindowFor(entry({ cmuxWindowId: "win-1" }), state)).toBe(42);
  });
});

describe("chooseAdoptionWindow -- window adoption / marker consolidation", () => {
  test("a single marker tab is kept as-is, no candidates to close", () => {
    const markers = [{ tabId: 1, windowId: 100 }];
    const byId = {};
    expect(chooseAdoptionWindow(markers, byId, [])).toEqual({ action: "keep", windowId: 100, closeTabIds: [] });
  });

  test("multiple marker tabs: the group-richest window's marker wins, the rest queue to close", () => {
    const markers = [
      { tabId: 1, windowId: 100 }, // 0 managed groups
      { tabId: 2, windowId: 200 }, // 2 managed groups
      { tabId: 3, windowId: 300 }, // 1 managed group
    ];
    const byId = {
      mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null },
      mw_b: { title: "beta", color: "red", archived: false, groupId: null, lastActiveTabId: null },
    };
    const allGroups = [
      { groupId: 10, windowId: 200, title: "alpha" },
      { groupId: 11, windowId: 200, title: "beta" },
      { groupId: 12, windowId: 300, title: "alpha" },
    ];
    const decision = chooseAdoptionWindow(markers, byId, allGroups);
    expect(decision.action).toBe("keep");
    expect(decision.windowId).toBe(200);
    expect(decision.closeTabIds.sort()).toEqual([1, 3]);
  });

  test("zero marker tabs: adopts the window with the most managed-title groups", () => {
    const byId = {
      mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null },
      mw_b: { title: "beta", color: "red", archived: false, groupId: null, lastActiveTabId: null },
    };
    const allGroups = [
      { groupId: 10, windowId: 200, title: "alpha" },
      { groupId: 11, windowId: 200, title: "beta" },
      { groupId: 12, windowId: 300, title: "alpha" },
    ];
    expect(chooseAdoptionWindow([], byId, allGroups)).toEqual({ action: "adopt", windowId: 200, closeTabIds: [] });
  });

  test("zero marker tabs, zero candidate windows: creates a brand-new window (the original last-resort behavior)", () => {
    expect(chooseAdoptionWindow([], {}, [])).toEqual({ action: "createNew", windowId: null, closeTabIds: [] });
  });

  test("zero marker tabs, groups exist but none match any managed title: still creates a brand-new window", () => {
    const byId = { mw_a: { title: "alpha", color: "blue", archived: false, groupId: null, lastActiveTabId: null } };
    const allGroups = [{ groupId: 10, windowId: 200, title: "someone else's tabs" }];
    expect(chooseAdoptionWindow([], byId, allGroups)).toEqual({ action: "createNew", windowId: null, closeTabIds: [] });
  });
});

describe("isolated e2e: window-split incident end to end (superseded by placement following below)", () => {
  test("boot with groups sitting in a window other than state.windowId adopts reality instead of orphaning them", () => {
    // Same starting shape as the original window-split incident (byId's
    // cached groupIds live in a window other than the one currently
    // resolved) -- but the FIX changed: adopt reality (record where they
    // actually are) rather than null them and wait for cross-window
    // recovery to slowly pull them back in over several syncs.
    const staleState = makeState({
      windowId: 555,
      activeId: "mw_a",
      byId: {
        mw_a: { title: "alpha", color: "blue", archived: false, groupId: 10, lastActiveTabId: 101 },
        mw_b: { title: "beta", color: "red", archived: false, groupId: 11, lastActiveTabId: 111 },
      },
    });

    const allGroupsAtOldWindow = [
      { groupId: 10, windowId: 777, title: "alpha" },
      { groupId: 11, windowId: 777, title: "beta" },
    ];
    const corrections = resolveGroupCache(staleState.byId, staleState, allGroupsAtOldWindow);
    expect(corrections).toEqual([
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 777 },
      { type: "local", name: "placementObserved", id: "mw_b", chromeWindowId: 777 },
    ]);

    let state = staleState;
    /** @type {Op[]} */
    const allOps = [];
    for (const fact of corrections) {
      const result = reduce(state, fact);
      state = result.state;
      allOps.push(...result.ops);
    }
    // Both groupIds survive intact -- never invalidated -- and both now
    // carry a placementOverride pointing at where they actually are.
    expect(state.byId.mw_a.groupId).toBe(10);
    expect(state.byId.mw_b.groupId).toBe(11);
    expect(state.byId.mw_a.placementOverride).toBe("777");
    expect(state.byId.mw_b.placementOverride).toBe("777");
    // Both moves get reported to the daemon.
    expect(allOps).toContainEqual({ op: "reportGroupPlacement", id: "mw_a", chromeWindowId: 777 });
    expect(allOps).toContainEqual({ op: "reportGroupPlacement", id: "mw_b", chromeWindowId: 777 });

    // The very next sync already targets them correctly -- activation and
    // ensureGroup both resolve to window 777 (the override), not 555 --
    // no waiting for cross-window recovery at all.
    const { ops: syncOps } = reduce(state, {
      type: "sync",
      seq: 2,
      config: { collapseOthers: true, closeBehavior: "archive" },
      state: {
        activeId: "mw_a",
        workspaces: [
          { id: "mw_a", title: "alpha", color: "blue", archived: false },
          { id: "mw_b", title: "beta", color: "red", archived: false },
        ],
      },
    });
    expect(syncOps).toContainEqual({ op: "ensureGroup", id: "mw_a", title: "alpha", color: "blue", windowId: 777, cmuxWindowId: null });
    expect(syncOps).toContainEqual({ op: "collapseOthers", exceptId: "mw_a", windowId: 777 });
  });
});

describe("placement following: the exact live case (docs/protocol.md, 'Placement ownership')", () => {
  // Zac's report, reproduced end to end: he manually moved a paired
  // window's groups into a second Chrome window; auto-switching stopped
  // for them. Move observed -> override recorded -> activation (and
  // collapseOthers scoping) target the group in its NEW window from then
  // on, with NO further attempt to move it back.
  test("a live move to window B is observed, recorded as an override, and immediately targeted there", () => {
    const state = makeState({
      windowId: 100, // window A, the group's original/legacy home
      byId: {
        mw_a: { title: "compliance", color: "blue", archived: false, groupId: 10, lastActiveTabId: 101 },
      },
    });

    // The user drags the "compliance" group into window B (200). Chrome
    // mints a new group id there (watchGroupPlacement's onCreated path --
    // see its own comment for why the id doesn't survive a cross-window
    // drag on most Chrome versions).
    const movedGroups = [{ groupId: 99, windowId: 200, title: "compliance" }];
    const drift = resolveGroupCache(state.byId, state, movedGroups);
    expect(drift).toEqual([
      { type: "local", name: "groupCreated", id: "mw_a", groupId: 99 },
      { type: "local", name: "placementObserved", id: "mw_a", chromeWindowId: 200 },
    ]);

    let next = state;
    /** @type {Op[]} */
    const driftOps = [];
    for (const fact of drift) {
      const result = reduce(next, fact);
      next = result.state;
      driftOps.push(...result.ops);
    }
    expect(next.byId.mw_a.groupId).toBe(99);
    expect(next.byId.mw_a.placementOverride).toBe("200");
    expect(driftOps).toContainEqual({ op: "reportGroupPlacement", id: "mw_a", chromeWindowId: 200 });

    // Activating this identity now targets window B, not window A --
    // activate() itself is window-agnostic (a real groupId works from any
    // window), but collapseOthers' own scoping proves the override is
    // actually being read: an unrelated identity still in window A must
    // NOT be collapsed by this activation (docs/protocol.md, "Chrome
    // window pairing": "activates/collapses groups ONLY within W's paired
    // Chrome window").
    const withOther = {
      ...next,
      byId: {
        ...next.byId,
        mw_other: { title: "other", color: "red", archived: false, groupId: 55, lastActiveTabId: null, cmuxWindowId: null, homeChromeWindowId: null, placementOverride: null },
      },
    };
    const { ops: activateOps } = reduce(withOther, {
      type: "event",
      seq: 1,
      name: "workspace.activated",
      workspace: { id: "mw_a", title: "compliance", color: "blue" },
    });
    expect(activateOps).toContainEqual({ op: "activate", id: "mw_a" });
    expect(activateOps).toContainEqual({ op: "collapseOthers", exceptId: "mw_a", windowId: 200 });
  });
});
