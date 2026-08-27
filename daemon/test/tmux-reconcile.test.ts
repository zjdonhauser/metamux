import { describe, expect, test } from "bun:test";
import {
  emptyReconcileState,
  reconcile,
  type CmuxActuatorAction,
  type ReconcileConfig,
  type ReconcileGlobalInput,
  type ReconcilePartitionInput,
  type ReconcileSession,
  type ReconcileState,
  type ReconcileTab,
  type ReconcileWindow,
  type ReconcileWindowsInput,
} from "../src/tmux-reconcile.ts";

const NOW = 1_000_000;

function config(overrides: Partial<ReconcileConfig> = {}): ReconcileConfig {
  return { mirrorMode: "windows", alphabetize: true, reattachGraceMs: 8000, spawnCwd: "/hub", now: NOW, ...overrides };
}

function session(id: string, name: string, attached = 1): ReconcileSession {
  return { id, name, attached };
}

function tab(id: string, title: string, opts: Partial<Pick<ReconcileTab, "pinned" | "index" | "selected">> = {}): ReconcileTab {
  return { id, title, pinned: opts.pinned ?? false, index: opts.index ?? 0, selected: opts.selected ?? false };
}

function win(id: string, tabs: ReconcileTab[], index = 0): ReconcileWindow {
  return { id, index, tabs };
}

function actionsOfType<T extends CmuxActuatorAction["type"]>(actions: CmuxActuatorAction[], type: T) {
  return actions.filter((a): a is Extract<CmuxActuatorAction, { type: T }> => a.type === type);
}

describe("reconcile -- windows mode: spawn", () => {
  test("a live session with no tab in a window gets spawned there", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "spawn", windowId: "win-1", sessionId: "$1", sessionName: "compliance", cwd: "/hub" }]);
    expect(out.registryIntents).toEqual([{ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance" }]);
  });

  test("a session already present (hosted) in the window is not re-spawned", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "spawn")).toEqual([]);
  });

  test("each window independently gets its own tab (true mirroring)", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", []), win("win-2", [])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    const spawns = actionsOfType(out.actions, "spawn");
    expect(spawns.map((a) => a.windowId).sort()).toEqual(["win-1", "win-2"]);
  });
});

describe("reconcile -- windows mode: title drift / title lock", () => {
  test("a hosted tab whose title has drifted from the session name is retitled", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "some other title")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "retitle", workspaceRef: "tab-a", title: "compliance" }]);
  });

  test("a hosted tab already titled correctly produces no retitle action", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "retitle")).toEqual([]);
  });
});

describe("reconcile -- windows mode: reattach after restore", () => {
  test("a tab titled for a live session with no hosting client is reattached", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(), // no client -- restored/detached
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "reattach", workspaceRef: "tab-a", sessionName: "compliance" }]);
  });

  test("throttled: a reattach attempted within the grace window is not repeated", () => {
    const state: ReconcileState = { ...emptyReconcileState(), reattachAttempts: new Map([["win-1|tab-a", NOW - 1000]]) };
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state,
      config: config({ reattachGraceMs: 8000 }),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reattach")).toEqual([]);
    // the throttle timestamp is carried forward unchanged, not reset
    expect(out.nextState.reattachAttempts.get("win-1|tab-a")).toBe(NOW - 1000);
  });

  test("re-admitted once the grace window has elapsed", () => {
    const state: ReconcileState = { ...emptyReconcileState(), reattachAttempts: new Map([["win-1|tab-a", NOW - 9000]]) };
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state,
      config: config({ reattachGraceMs: 8000 }),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reattach")).toHaveLength(1);
    expect(out.nextState.reattachAttempts.get("win-1|tab-a")).toBe(NOW);
  });

  test("a tab titled for a live session is treated as present -- no duplicate spawn alongside the reattach", () => {
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "spawn")).toEqual([]);
  });
});

describe("reconcile -- windows mode: reap", () => {
  test("a tracked tab whose session died is closed and archived", () => {
    const state: ReconcileState = { ...emptyReconcileState(), windowAttachments: new Map([["win-1", new Map([["$1", "tab-a"]])]]) };
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [], // $1 is gone
      hostMap: new Map(),
      windows: [win("win-1", [])], // the tab itself is also already gone from cmux's own listing
      state,
      config: config(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([{ type: "reap", workspaceRef: "tab-a" }]);
    expect(out.registryIntents).toContainEqual({ type: "archiveTmuxRef", sessionId: "$1" });
  });

  test("a whole window disappearing drops its state with no explicit reap call", () => {
    const state: ReconcileState = { ...emptyReconcileState(), windowAttachments: new Map([["win-dead", new Map([["$1", "tab-a"]])]]) };
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [], // win-dead no longer exists
      state,
      config: config(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([]);
    expect(out.nextState.windowAttachments.has("win-dead")).toBe(false);
  });

  test("a still-live session's tracked tab is never reaped", () => {
    const state: ReconcileState = { ...emptyReconcileState(), windowAttachments: new Map([["win-1", new Map([["$1", "tab-a"]])]]) };
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      state,
      config: config(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([]);
  });
});

describe("reconcile -- windows mode: alphabetize", () => {
  test("pinned tabs stay put; unpinned tabs sort case-insensitively", () => {
    const sessions = [session("$1", "zzz"), session("$2", "Aaa"), session("$3", "mmm")];
    const hostMap = new Map([
      ["tab-zzz", "$1"],
      ["tab-aaa", "$2"],
      ["tab-mmm", "$3"],
    ]);
    const windows = [
      win("win-1", [
        tab("tab-pinned", "pinned-one", { pinned: true, index: 0 }),
        tab("tab-zzz", "zzz", { index: 1 }),
        tab("tab-aaa", "Aaa", { index: 2 }),
        tab("tab-mmm", "mmm", { index: 3 }),
      ]),
    ];
    const input: ReconcileWindowsInput = { mode: "windows", sessions, hostMap, windows, state: emptyReconcileState(), config: config() };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reorder")).toEqual([
      { type: "reorder", windowId: "win-1", orderedWorkspaceRefs: ["tab-pinned", "tab-aaa", "tab-mmm", "tab-zzz"] },
    ]);
  });

  test("an already-sorted window produces zero reorder calls", () => {
    const sessions = [session("$1", "aaa"), session("$2", "bbb")];
    const hostMap = new Map([
      ["tab-aaa", "$1"],
      ["tab-bbb", "$2"],
    ]);
    const windows = [win("win-1", [tab("tab-aaa", "aaa", { index: 0 }), tab("tab-bbb", "bbb", { index: 1 })])];
    const input: ReconcileWindowsInput = { mode: "windows", sessions, hostMap, windows, state: emptyReconcileState(), config: config() };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reorder")).toEqual([]);
  });

  test("disabled via config.alphabetize -- no reorder actions even when out of order", () => {
    const sessions = [session("$1", "zzz"), session("$2", "aaa")];
    const hostMap = new Map([
      ["tab-zzz", "$1"],
      ["tab-aaa", "$2"],
    ]);
    const windows = [win("win-1", [tab("tab-zzz", "zzz", { index: 0 }), tab("tab-aaa", "aaa", { index: 1 })])];
    const input: ReconcileWindowsInput = {
      mode: "windows",
      sessions,
      hostMap,
      windows,
      state: emptyReconcileState(),
      config: config({ alphabetize: false }),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reorder")).toEqual([]);
  });
});

describe("reconcile -- windows mode: rename survives via id-keyed state", () => {
  test("a session renamed between ticks keeps its identity (same session id, new name)", () => {
    // First tick: session $1 named "old-name" is hosted by tab-a.
    const tick1: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "old-name")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "old-name")])],
      state: emptyReconcileState(),
      config: config(),
    };
    const out1 = reconcile(tick1);
    expect(out1.nextState.windowAttachments.get("win-1")?.get("$1")).toBe("tab-a");

    // Second tick: tmux-source.ts's diff already renamed $1 to "new-name";
    // the cmux tab's title hasn't caught up yet.
    const tick2: ReconcileWindowsInput = {
      mode: "windows",
      sessions: [session("$1", "new-name")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "old-name")])],
      state: out1.nextState,
      config: config(),
    };
    const out2 = reconcile(tick2);
    expect(out2.actions).toEqual([{ type: "retitle", workspaceRef: "tab-a", title: "new-name" }]);
    expect(out2.registryIntents).toEqual([{ type: "upsertTmuxRef", sessionId: "$1", sessionName: "new-name" }]);
    // still the same tracked tab -- a rename never looks like a reap+spawn
    expect(out2.nextState.windowAttachments.get("win-1")?.get("$1")).toBe("tab-a");
  });
});

describe("reconcile -- global mode", () => {
  function globalConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "global", ...overrides });
  }

  test("an unattended session with no existing tab is spawned, targeting no window", () => {
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [session("$1", "wakey", 0)],
      hostMap: new Map(),
      allTabs: [],
      state: emptyReconcileState(),
      config: globalConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "spawn", windowId: null, sessionId: "$1", sessionName: "wakey", cwd: "/hub" }]);
  });

  test("an attended session (attached everywhere) is left alone", () => {
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [session("$1", "wakey", 1)],
      hostMap: new Map(),
      allTabs: [],
      state: emptyReconcileState(),
      config: globalConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([]);
  });

  test("a tab already titled for the session but untracked is left alone (faithful port of tick.py's gap, plan §1.6/§4)", () => {
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [session("$1", "wakey", 0)],
      hostMap: new Map(),
      allTabs: [tab("tab-untracked", "wakey")],
      state: emptyReconcileState(), // not tracked in state.globalAttachments
      config: globalConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([]);
  });

  test("a tracked, still-live tab is reattached, throttled by the shared grace window", () => {
    const state: ReconcileState = { ...emptyReconcileState(), globalAttachments: new Map([["$1", "tab-a"]]) };
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [session("$1", "wakey", 0)],
      hostMap: new Map(),
      allTabs: [tab("tab-a", "wakey")],
      state,
      config: globalConfig({ reattachGraceMs: 15000 }),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "reattach", workspaceRef: "tab-a", sessionName: "wakey" }]);
  });

  test("reattach throttled within the grace window produces no action", () => {
    const state: ReconcileState = {
      ...emptyReconcileState(),
      globalAttachments: new Map([["$1", "tab-a"]]),
      reattachAttempts: new Map([["$1", NOW - 1000]]),
    };
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [session("$1", "wakey", 0)],
      hostMap: new Map(),
      allTabs: [tab("tab-a", "wakey")],
      state,
      config: globalConfig({ reattachGraceMs: 15000 }),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([]);
  });

  test("a dead session's tracked tab is reaped and archived", () => {
    const state: ReconcileState = { ...emptyReconcileState(), globalAttachments: new Map([["$1", "tab-a"]]) };
    const input: ReconcileGlobalInput = {
      mode: "global",
      sessions: [], // $1 no longer exists
      hostMap: new Map(),
      allTabs: [],
      state,
      config: globalConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "reap", workspaceRef: "tab-a" }]);
    expect(out.registryIntents).toContainEqual({ type: "archiveTmuxRef", sessionId: "$1" });
    expect(out.nextState.globalAttachments.has("$1")).toBe(false);
  });
});

describe("reconcile -- partition mode: spawn placement", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", ...overrides });
  }

  test("a session with no tab anywhere spawns in the FOCUSED window", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [], 0), win("win-2", [], 1)],
      focusedWindowId: "win-2",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "spawn", windowId: "win-2", sessionId: "$1", sessionName: "compliance", cwd: "/hub" }]);
    expect(out.registryIntents).toEqual([{ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance", cmuxWindowId: "win-2" }]);
  });

  test("no focused window falls back to the LOWEST-INDEX window", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-b", [], 5), win("win-a", [], 1)],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "spawn", windowId: "win-a", sessionId: "$1", sessionName: "compliance", cwd: "/hub" }]);
  });

  test("a focusedWindowId that no longer exists (window closed) also falls back to lowest-index", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-a", [], 0), win("win-b", [], 1)],
      focusedWindowId: "win-stale",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "spawn", windowId: "win-a", sessionId: "$1", sessionName: "compliance", cwd: "/hub" }]);
  });

  test("zero windows at all -- nothing to spawn into, no crash", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([]);
    expect(out.registryIntents).toEqual([]);
  });

  test("an already-present single tab is not re-spawned", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "compliance", { selected: true })])],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "spawn")).toEqual([]);
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-a", windowId: "win-1" });
  });
});

describe("reconcile -- partition mode: title lock and reattach (single-candidate case)", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", ...overrides });
  }

  test("a hosted tab whose title drifted is retitled", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "some other title", { selected: true })])],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "retitle", workspaceRef: "tab-a", title: "compliance" }]);
  });

  test("a title-matched but unhosted tab is reattached, throttled", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(), // no client -- restored/detached
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "reattach", workspaceRef: "tab-a", sessionName: "compliance" }]);
    // not recorded as a confirmed attachment yet -- same warmup precedent as windows mode
    expect(out.nextState.partitionAttachments.has("$1")).toBe(false);
  });

  test("reattach throttled within the grace window is not repeated", () => {
    const state: ReconcileState = { ...emptyReconcileState(), reattachAttempts: new Map([["win-1|tab-a", NOW - 1000]]) };
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(),
      windows: [win("win-1", [tab("tab-a", "compliance")])],
      focusedWindowId: "win-1",
      state,
      config: partitionConfig({ reattachGraceMs: 8000 }),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reattach")).toEqual([]);
  });
});

describe("reconcile -- partition mode: multi-window legacy convergence (the one that matters most)", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", alphabetize: false, ...overrides });
  }

  test("exactly one duplicate is selected -- IT survives, the other is reaped", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([
        ["tab-in-win1", "$1"],
        ["tab-in-win2", "$1"],
      ]),
      windows: [
        win("win-1", [tab("tab-in-win1", "compliance", { selected: false })], 0),
        win("win-2", [tab("tab-in-win2", "compliance", { selected: true })], 1),
      ],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([{ type: "reap", workspaceRef: "tab-in-win1" }]);
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-in-win2", windowId: "win-2" });
  });

  test("BOTH duplicates selected (routine in mirror mode) -- falls back to lowest window index", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([
        ["tab-in-win5", "$1"],
        ["tab-in-win2", "$1"],
      ]),
      windows: [
        win("win-5", [tab("tab-in-win5", "compliance", { selected: true })], 5),
        win("win-2", [tab("tab-in-win2", "compliance", { selected: true })], 2),
      ],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    // win-2 has the lower index (2 < 5) -- its tab survives
    expect(actionsOfType(out.actions, "reap")).toEqual([{ type: "reap", workspaceRef: "tab-in-win5" }]);
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-in-win2", windowId: "win-2" });
  });

  test("NEITHER duplicate selected -- falls back to lowest window index", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([
        ["tab-in-win3", "$1"],
        ["tab-in-win0", "$1"],
      ]),
      windows: [win("win-3", [tab("tab-in-win3", "compliance")], 3), win("win-0", [tab("tab-in-win0", "compliance")], 0)],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([{ type: "reap", workspaceRef: "tab-in-win3" }]);
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-in-win0", windowId: "win-0" });
  });

  test("THREE-way duplicate (a real mirror-era shape): exactly one survives, the other two reap in the same tick", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([
        ["tab-w0", "$1"],
        ["tab-w1", "$1"],
        ["tab-w2", "$1"],
      ]),
      windows: [
        win("win-0", [tab("tab-w0", "compliance")], 0),
        win("win-1", [tab("tab-w1", "compliance", { selected: true })], 1),
        win("win-2", [tab("tab-w2", "compliance")], 2),
      ],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    // win-1's tab is the only one selected -- it wins regardless of index
    expect(actionsOfType(out.actions, "reap").map((a) => a.workspaceRef).sort()).toEqual(["tab-w0", "tab-w2"]);
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-w1", windowId: "win-1" });
  });

  test("one-time convergence: the NEXT tick after reaping sees only one candidate and reaps nothing further", () => {
    const tick1: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([
        ["tab-in-win1", "$1"],
        ["tab-in-win2", "$1"],
      ]),
      windows: [win("win-1", [tab("tab-in-win1", "compliance")], 0), win("win-2", [tab("tab-in-win2", "compliance", { selected: true })], 1)],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out1 = reconcile(tick1);
    expect(actionsOfType(out1.actions, "reap")).toHaveLength(1);

    // Tick 2: the reaped tab is actually gone now (cmux caught up).
    const tick2: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-in-win2", "$1"]]),
      windows: [win("win-1", []), win("win-2", [tab("tab-in-win2", "compliance", { selected: true })], 1)],
      focusedWindowId: null,
      state: out1.nextState,
      config: partitionConfig(),
    };
    const out2 = reconcile(tick2);
    expect(actionsOfType(out2.actions, "reap")).toEqual([]);
  });

  test("title-matched (unhosted) duplicates also converge -- multiple restored/detached copies reap down to one", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map(), // neither has a live client
      windows: [win("win-3", [tab("tab-w3", "compliance")], 3), win("win-1", [tab("tab-w1", "compliance")], 1)],
      focusedWindowId: null,
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([{ type: "reap", workspaceRef: "tab-w3" }]);
    expect(actionsOfType(out.actions, "reattach")).toEqual([{ type: "reattach", workspaceRef: "tab-w1", sessionName: "compliance" }]);
  });
});

describe("reconcile -- partition mode: user tab move between windows is respected", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", alphabetize: false, ...overrides });
  }

  test("a tracked tab found in a DIFFERENT window this tick updates the attachment -- nothing moves it back", () => {
    const state: ReconcileState = { ...emptyReconcileState(), partitionAttachments: new Map([["$1", { tabId: "tab-a", windowId: "win-1" }]]) };
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      // Same tab id, now reported under win-2 (the user dragged it there).
      windows: [win("win-1", [], 0), win("win-2", [tab("tab-a", "compliance", { selected: true })], 1)],
      focusedWindowId: "win-1",
      state,
      config: partitionConfig(),
    };
    const out = reconcile(input);
    // No spawn (it's still present, just elsewhere), no reap (only one candidate).
    expect(out.actions.find((a) => a.type === "spawn" || a.type === "reap")).toBeUndefined();
    expect(out.nextState.partitionAttachments.get("$1")).toEqual({ tabId: "tab-a", windowId: "win-2" });
  });
});

describe("reconcile -- partition mode: reap on session death", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", ...overrides });
  }

  test("a tracked session no longer live has its tab reaped and archived", () => {
    const state: ReconcileState = { ...emptyReconcileState(), partitionAttachments: new Map([["$1", { tabId: "tab-a", windowId: "win-1" }]]) };
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [], // $1 is gone
      hostMap: new Map(),
      windows: [win("win-1", [])],
      focusedWindowId: null,
      state,
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(out.actions).toEqual([{ type: "reap", workspaceRef: "tab-a" }]);
    expect(out.registryIntents).toEqual([{ type: "archiveTmuxRef", sessionId: "$1" }]);
    expect(out.nextState.partitionAttachments.has("$1")).toBe(false);
  });

  test("a still-live session's tracked tab is never reaped", () => {
    const state: ReconcileState = { ...emptyReconcileState(), partitionAttachments: new Map([["$1", { tabId: "tab-a", windowId: "win-1" }]]) };
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "compliance")],
      hostMap: new Map([["tab-a", "$1"]]),
      windows: [win("win-1", [tab("tab-a", "compliance", { selected: true })])],
      focusedWindowId: "win-1",
      state,
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reap")).toEqual([]);
  });
});

describe("reconcile -- partition mode: alphabetize (UX parity, not explicitly contracted)", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", ...overrides });
  }

  test("a window hosting one of our tabs is alphabetized alongside its other tabs", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "zzz")],
      hostMap: new Map([["tab-zzz", "$1"]]),
      windows: [win("win-1", [tab("tab-zzz", "zzz", { index: 0, selected: true }), tab("tab-aaa", "aaa", { index: 1 })])],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reorder")).toEqual([
      { type: "reorder", windowId: "win-1", orderedWorkspaceRefs: ["tab-aaa", "tab-zzz"] },
    ]);
  });

  test("disabled via config.alphabetize -- no reorder actions", () => {
    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions: [session("$1", "zzz")],
      hostMap: new Map([["tab-zzz", "$1"]]),
      windows: [win("win-1", [tab("tab-zzz", "zzz", { index: 0, selected: true }), tab("tab-aaa", "aaa", { index: 1 })])],
      focusedWindowId: "win-1",
      state: emptyReconcileState(),
      config: partitionConfig({ alphabetize: false }),
    };
    const out = reconcile(input);
    expect(actionsOfType(out.actions, "reorder")).toEqual([]);
  });
});

describe("reconcile -- partition mode: Zac's real shape (8 sessions x 2 windows, one-tick convergence)", () => {
  function partitionConfig(overrides: Partial<ReconcileConfig> = {}) {
    return config({ mirrorMode: "partition", alphabetize: false, ...overrides });
  }

  test("every session with duplicates in both windows converges to exactly one tab each, in a single tick", () => {
    const sessionNames = ["cmux", "compliance", "mh-accounts", "oprey-ingest", "plugins", "wakey", "data-request", "julia-reviews"];
    const sessions = sessionNames.map((name, i) => session(`$${i}`, name));

    const hostMap = new Map<string, string>();
    const win1Tabs: ReconcileTab[] = [];
    const win2Tabs: ReconcileTab[] = [];
    sessionNames.forEach((name, i) => {
      const tabA = `tab-${name}-w1`;
      const tabB = `tab-${name}-w2`;
      hostMap.set(tabA, `$${i}`);
      hostMap.set(tabB, `$${i}`);
      // Exactly one session ("cmux", index 0) is the one actively selected
      // in window 2 -- everything else has no clear winner (mirrors a
      // real "nothing is selected in most tabs right now" snapshot).
      win1Tabs.push(tab(tabA, name, { index: i }));
      win2Tabs.push(tab(tabB, name, { index: i, selected: name === "cmux" }));
    });

    const input: ReconcilePartitionInput = {
      mode: "partition",
      sessions,
      hostMap,
      windows: [win("win-1", win1Tabs, 0), win("win-2", win2Tabs, 1)],
      focusedWindowId: "win-2",
      state: emptyReconcileState(),
      config: partitionConfig(),
    };
    const out = reconcile(input);

    // Exactly 8 reaps (one per session -- the OTHER window's duplicate).
    expect(actionsOfType(out.actions, "reap")).toHaveLength(8);
    // No spawns, no reattaches -- every session already had a live tab.
    expect(actionsOfType(out.actions, "spawn")).toEqual([]);
    expect(actionsOfType(out.actions, "reattach")).toEqual([]);
    // Exactly one partitionAttachment per session.
    expect(out.nextState.partitionAttachments.size).toBe(8);
    // "cmux" is selected in win-2 -- it wins outright, regardless of index.
    expect(out.nextState.partitionAttachments.get("$0")).toEqual({ tabId: "tab-cmux-w2", windowId: "win-2" });
    // Every other session has no selected duplicate -- lowest window index
    // (win-1, index 0) wins for all of them.
    for (let i = 1; i < sessionNames.length; i++) {
      const name = sessionNames[i]!;
      expect(out.nextState.partitionAttachments.get(`$${i}`)).toEqual({ tabId: `tab-${name}-w1`, windowId: "win-1" });
    }
    // Every registry intent carries the correct home window.
    const upserts = out.registryIntents.filter((r) => r.type === "upsertTmuxRef");
    expect(upserts).toHaveLength(8);
    for (const u of upserts) {
      if (u.type !== "upsertTmuxRef") continue;
      const attachment = out.nextState.partitionAttachments.get(u.sessionId);
      expect(u.cmuxWindowId).toBe(attachment!.windowId);
    }
  });
});
