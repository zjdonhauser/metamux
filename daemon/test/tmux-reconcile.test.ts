import { describe, expect, test } from "bun:test";
import {
  emptyReconcileState,
  reconcile,
  type CmuxActuatorAction,
  type ReconcileConfig,
  type ReconcileGlobalInput,
  type ReconcileSession,
  type ReconcileState,
  type ReconcileTab,
  type ReconcileWindowsInput,
} from "../src/tmux-reconcile.ts";

const NOW = 1_000_000;

function config(overrides: Partial<ReconcileConfig> = {}): ReconcileConfig {
  return { mirrorMode: "windows", alphabetize: true, reattachGraceMs: 8000, spawnCwd: "/hub", now: NOW, ...overrides };
}

function session(id: string, name: string, attached = 1): ReconcileSession {
  return { id, name, attached };
}

function tab(id: string, title: string, opts: Partial<Pick<ReconcileTab, "pinned" | "index">> = {}): ReconcileTab {
  return { id, title, pinned: opts.pinned ?? false, index: opts.index ?? 0 };
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
      windows: [{ id: "win-1", tabs: [] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [
        { id: "win-1", tabs: [] },
        { id: "win-2", tabs: [] },
      ],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "some other title")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      windows: [{ id: "win-1", tabs: [] }], // the tab itself is also already gone from cmux's own listing
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "compliance")] }],
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
      {
        id: "win-1",
        tabs: [
          tab("tab-pinned", "pinned-one", { pinned: true, index: 0 }),
          tab("tab-zzz", "zzz", { index: 1 }),
          tab("tab-aaa", "Aaa", { index: 2 }),
          tab("tab-mmm", "mmm", { index: 3 }),
        ],
      },
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
    const windows = [{ id: "win-1", tabs: [tab("tab-aaa", "aaa", { index: 0 }), tab("tab-bbb", "bbb", { index: 1 })] }];
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
    const windows = [{ id: "win-1", tabs: [tab("tab-zzz", "zzz", { index: 0 }), tab("tab-aaa", "aaa", { index: 1 })] }];
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "old-name")] }],
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
      windows: [{ id: "win-1", tabs: [tab("tab-a", "old-name")] }],
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
