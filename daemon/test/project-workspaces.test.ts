import { describe, expect, test } from "bun:test";
import { projectWorkspaces, type TmuxSession } from "../src/model/project-workspaces.ts";
import type { Workspace } from "../src/model/identity.ts";

// The workspace set is a PROJECTION of `tmux list-sessions`, not a store that
// accumulates. The live registry this model replaces held 18 non-archived
// workspaces for 7 real sessions, including 3 duplicates and 8 orphans.

let counter = 0;
const mint = () => `minted-${++counter}`;
const reset = () => (counter = 0);

const stored = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  sessionName: "alpha",
  label: "alpha",
  cmuxWindowId: "cw1",
  harness: null,
  archived: false,
  ...over,
});

const session = (name: string, metamuxId: string | null = null): TmuxSession => ({ name, metamuxId });

describe("projectWorkspaces", () => {
  test("keeps a workspace whose session still carries its minted id", () => {
    reset();
    const { workspaces, toStamp } = projectWorkspaces([session("alpha", "w1")], [stored()], mint);
    expect(workspaces).toEqual([stored()]);
    expect(toStamp).toEqual([]);
  });

  // The tmux-server-restart path: options are gone, so the name is the
  // rendezvous key for exactly one moment, then the id is re-stamped.
  test("re-links by name after a tmux restart and re-stamps the id", () => {
    reset();
    const { workspaces, toStamp } = projectWorkspaces([session("alpha", null)], [stored()], mint);
    expect(workspaces[0].id).toBe("w1");
    expect(toStamp).toEqual([{ sessionName: "alpha", id: "w1" }]);
  });

  test("mints and stamps an id for a session it has never seen", () => {
    reset();
    const { workspaces, toStamp } = projectWorkspaces([session("brand-new", null)], [], mint);
    expect(workspaces).toEqual([
      { id: "minted-1", sessionName: "brand-new", label: "brand-new", cmuxWindowId: null, harness: null, archived: false },
    ]);
    expect(toStamp).toEqual([{ sessionName: "brand-new", id: "minted-1" }]);
  });

  // A rename must not create a second workspace. The stamped id outlives the
  // name, which is the entire reason identity is minted rather than hashed.
  test("follows a rename without creating a duplicate", () => {
    reset();
    const { workspaces, toStamp } = projectWorkspaces([session("alpha-renamed", "w1")], [stored()], mint);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe("w1");
    expect(workspaces[0].sessionName).toBe("alpha-renamed");
    expect(workspaces[0].label).toBe("alpha-renamed");
    expect(workspaces[0].cmuxWindowId).toBe("cw1");
    expect(toStamp).toEqual([]);
  });

  test("archives a stored workspace whose session is gone", () => {
    reset();
    const { workspaces } = projectWorkspaces([], [stored()], mint);
    expect(workspaces).toEqual([{ ...stored(), archived: true }]);
  });

  test("revives an archived workspace when its session comes back", () => {
    reset();
    const { workspaces } = projectWorkspaces([session("alpha", "w1")], [stored({ archived: true })], mint);
    expect(workspaces[0].archived).toBe(false);
  });

  // The orphan/duplicate accumulation this model exists to prevent.
  test("never emits a duplicate or an orphan for the live session set", () => {
    reset();
    const sessions = ["blocked", "cmux", "mh-accounts", "review-team"].map((n) => session(n));
    const junk = [
      stored({ id: "d1", sessionName: "mh-accounts", label: "mh-accounts" }),
      stored({ id: "d2", sessionName: "mh-accounts", label: "mh-accounts" }),
      stored({ id: "o1", sessionName: "oprey-ingest", label: "oprey-ingest" }),
      stored({ id: "o2", sessionName: "Terminal 1", label: "Terminal 1" }),
    ];
    const { workspaces } = projectWorkspaces(sessions, junk, mint);

    const live = workspaces.filter((w) => !w.archived);
    expect(live).toHaveLength(4);
    expect(new Set(live.map((w) => w.label)).size).toBe(4);
    // The orphans survive only as archived tombstones, never as live workspaces.
    expect(live.find((w) => w.label === "oprey-ingest")).toBeUndefined();
    expect(live.find((w) => w.label === "Terminal 1")).toBeUndefined();
  });

  // Two stored rows claiming one name is exactly the duplicate state in the
  // live registry. Re-link must pick one and archive the other, not both.
  test("collapses duplicate stored rows onto one live workspace", () => {
    reset();
    const dupes = [stored({ id: "a" }), stored({ id: "b" })];
    const { workspaces } = projectWorkspaces([session("alpha", null)], dupes, mint);
    expect(workspaces.filter((w) => !w.archived)).toHaveLength(1);
    expect(workspaces.filter((w) => w.archived)).toHaveLength(1);
  });

  test("is empty for no sessions and no stored state", () => {
    reset();
    expect(projectWorkspaces([], [], mint)).toEqual({ workspaces: [], toStamp: [] });
  });
});
