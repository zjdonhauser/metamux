import { beforeEach, describe, expect, test } from "bun:test";
import { IdentityEngine, type EngineIO } from "../../src/model/engine.ts";
import { EMPTY, type DesiredState } from "../../src/model/store.ts";
import type { TmuxSession } from "../../src/model/project-workspaces.ts";

// A fake EngineIO: the engine is orchestration, so it is tested without a tmux
// server, a browser, or the filesystem.
class FakeIO implements EngineIO {
  sessions: TmuxSession[] = [];
  stamped: { sessionName: string; id: string }[] = [];
  saved: DesiredState[] = [];
  state: DesiredState = { ...EMPTY };
  private minted = 0;

  listSessions() {
    return this.sessions;
  }
  stampId(sessionName: string, id: string) {
    this.stamped.push({ sessionName, id });
    return true;
  }
  load() {
    return this.state;
  }
  save(state: DesiredState) {
    this.state = state;
    this.saved.push(state);
  }
  mintId() {
    return `mw_${++this.minted}`;
  }
}

let io: FakeIO;
let engine: IdentityEngine;

beforeEach(() => {
  io = new FakeIO();
  engine = new IdentityEngine(io);
});

describe("refresh", () => {
  test("mints and stamps an id for a new session", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    expect(engine.workspaces.map((w) => w.label)).toEqual(["alpha"]);
    expect(io.stamped).toEqual([{ sessionName: "alpha", id: "mw_1" }]);
  });

  test("does not re-stamp a session that already carries its id", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    io.sessions = [{ name: "alpha", metamuxId: "mw_1" }];
    io.stamped = [];
    engine.refresh();
    expect(io.stamped).toEqual([]);
  });

  test("persists on every refresh so a daemon restart resumes", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    expect(io.saved.length).toBeGreaterThan(0);
    expect(io.state.workspaces).toHaveLength(1);
  });

  test("archives a workspace whose session is gone", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    io.sessions = [];
    engine.refresh();
    expect(engine.workspaces.every((w) => w.archived)).toBe(true);
  });
});

describe("workspaceFor", () => {
  beforeEach(() => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
  });

  test("resolves by stamped id", () => {
    const w = engine.workspaceFor({ kind: "tmux", sessionName: "whatever", metamuxId: "mw_1" });
    expect(w?.label).toBe("alpha");
  });

  // The window after a tmux server restart, before re-stamping lands.
  test("resolves by session name when unstamped", () => {
    const w = engine.workspaceFor({ kind: "tmux", sessionName: "alpha", metamuxId: null });
    expect(w?.id).toBe("mw_1");
  });

  // Fail loud: no workspace, so the caller prints the URL instead of guessing.
  test("refuses a caller outside tmux", () => {
    expect(engine.workspaceFor({ kind: "not-in-tmux" })).toBeNull();
  });

  test("refuses an unknown session rather than picking a neighbour", () => {
    expect(engine.workspaceFor({ kind: "tmux", sessionName: "nope", metamuxId: null })).toBeNull();
  });

  test("never resolves to an archived workspace", () => {
    io.sessions = [];
    engine.refresh();
    expect(engine.workspaceFor({ kind: "tmux", sessionName: "alpha", metamuxId: "mw_1" })).toBeNull();
  });
});

describe("plan", () => {
  test("creates a group once the workspace has a paired window", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    engine.placeWorkspace("mw_1", "cw1");
    engine.observePair({ cmuxWindowId: "cw1", chromeWindowId: "CH1" }, ["cw1"], ["CH1"]);

    expect(engine.plan({ groups: [] })).toEqual([
      { kind: "createGroup", workspaceId: "mw_1", label: "alpha", chromeWindowId: "CH1" },
    ]);
  });

  // Follow-the-tab, entirely emergent: nothing here implements it.
  test("moves the group when the workspace changes cmux window", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    engine.observePair({ cmuxWindowId: "cw1", chromeWindowId: "CH1" }, ["cw1", "cw2"], ["CH1", "CH2"]);
    engine.observePair({ cmuxWindowId: "cw2", chromeWindowId: "CH2" }, ["cw1", "cw2"], ["CH1", "CH2"]);
    engine.placeWorkspace("mw_1", "cw2");

    const observed = { groups: [{ groupId: 10, label: "alpha", chromeWindowId: "CH1", tabs: [{ tabId: 1, url: "https://x" }] }] };
    expect(engine.plan(observed)).toEqual([{ kind: "moveGroup", groupId: 10, toChromeWindowId: "CH2" }]);
  });

  test("plans nothing when the workspace has no pair yet", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    engine.placeWorkspace("mw_1", "cw1");
    expect(engine.plan({ groups: [] })).toEqual([]);
  });
});

describe("placeWorkspace", () => {
  test("persists only on a real change", () => {
    io.sessions = [{ name: "alpha", metamuxId: null }];
    engine.refresh();
    const writes = io.saved.length;
    engine.placeWorkspace("mw_1", "cw1");
    expect(io.saved.length).toBe(writes + 1);
    engine.placeWorkspace("mw_1", "cw1");
    expect(io.saved.length).toBe(writes + 1);
  });
});
