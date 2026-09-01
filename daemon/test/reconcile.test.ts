import { describe, expect, test } from "bun:test";
import { reconcile } from "../src/model/reconcile.ts";
import type { Desired, Observed, Workspace } from "../src/model/identity.ts";

// Every test is a fixture pair: a desired state, an observed state, and the
// actions that must follow. No browser, no tmux, no daemon -- the whole point
// of making reconcile() pure and total.

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  sessionName: "alpha",
  label: "alpha",
  cmuxWindowId: "cw1",
  harness: null,
  archived: false,
  ...over,
});

const desired = (over: Partial<Desired> = {}): Desired => ({
  workspaces: [ws()],
  pairs: [{ cmuxWindowId: "cw1", chromeWindowId: "CH1" }],
  ...over,
});

const group = (over: Partial<Observed["groups"][0]> = {}) => ({
  groupId: 10,
  label: "alpha",
  chromeWindowId: "CH1",
  tabs: [{ tabId: 1, url: "https://example.com" }],
  ...over,
});

describe("reconcile: Workspace -> TabGroup", () => {
  test("creates the group when the workspace has none", () => {
    expect(reconcile(desired(), { groups: [] })).toEqual([
      { kind: "createGroup", workspaceId: "w1", label: "alpha", chromeWindowId: "CH1" },
    ]);
  });

  test("does nothing when the group already sits in the desired window", () => {
    expect(reconcile(desired(), { groups: [group()] })).toEqual([]);
  });

  // Two groups for one workspace: merge, never discard a tab.
  test("merges a duplicate group into the canonical one", () => {
    const actions = reconcile(desired(), { groups: [group(), group({ groupId: 11 })] });
    expect(actions).toContainEqual({ kind: "mergeGroups", fromGroupId: 11, intoGroupId: 10 });
  });

  // A workspace with no cmux window has no desired Chrome window, so there is
  // nowhere to create a group. Refusing beats guessing.
  test("creates nothing when the workspace has no window pair", () => {
    expect(reconcile(desired({ workspaces: [ws({ cmuxWindowId: null })] }), { groups: [] })).toEqual([]);
  });
});

describe("reconcile: TabGroup -> ChromeWindow", () => {
  // This single rule replaces the entire follow-the-tab feature: the workspace
  // moved to another cmux window, so the desired path now resolves elsewhere.
  test("moves the group when observed and desired windows disagree", () => {
    expect(reconcile(desired(), { groups: [group({ chromeWindowId: "CH2" })] })).toEqual([
      { kind: "moveGroup", groupId: 10, toChromeWindowId: "CH1" },
    ]);
  });

  test("follows the workspace to a second cmux window", () => {
    const d = desired({
      workspaces: [ws({ cmuxWindowId: "cw2" })],
      pairs: [
        { cmuxWindowId: "cw1", chromeWindowId: "CH1" },
        { cmuxWindowId: "cw2", chromeWindowId: "CH2" },
      ],
    });
    expect(reconcile(d, { groups: [group({ chromeWindowId: "CH1" })] })).toEqual([
      { kind: "moveGroup", groupId: 10, toChromeWindowId: "CH2" },
    ]);
  });

  test("does not move a group when its cmux window has no pair yet", () => {
    const d = desired({ workspaces: [ws({ cmuxWindowId: "cw9" })] });
    expect(reconcile(d, { groups: [group()] })).toEqual([]);
  });
});

describe("reconcile: unmanaged groups are never adopted", () => {
  test("reports a foreign group with real tabs and leaves it alone", () => {
    const actions = reconcile(desired(), { groups: [group(), group({ groupId: 99, label: "personal banking" })] });
    expect(actions).toContainEqual({ kind: "reportForeign", groupId: 99, label: "personal banking" });
    expect(actions.find((a) => a.kind === "moveGroup")).toBeUndefined();
  });

  test("closes an unmanaged group whose tabs are all blank placeholders", () => {
    const blank = group({ groupId: 98, label: "leftover", tabs: [{ tabId: 5, url: "chrome://newtab/" }] });
    const actions = reconcile(desired(), { groups: [group(), blank] });
    expect(actions).toContainEqual({ kind: "closeBlankGroup", groupId: 98 });
  });

  // The rule the 72-tab incident argues for: a Chrome group metamux did not
  // create never becomes a workspace.
  test("never creates a workspace from a foreign group", () => {
    const actions = reconcile({ workspaces: [], pairs: [] }, { groups: [group({ label: "random" })] });
    expect(actions).toEqual([{ kind: "reportForeign", groupId: 10, label: "random" }]);
  });
});

describe("reconcile: archived workspaces", () => {
  test("archives the group of an archived workspace", () => {
    const d = desired({ workspaces: [ws({ archived: true })] });
    expect(reconcile(d, { groups: [group()] })).toEqual([{ kind: "archiveGroup", groupId: 10 }]);
  });

  test("an archived workspace with no group needs no action", () => {
    expect(reconcile(desired({ workspaces: [ws({ archived: true })] }), { groups: [] })).toEqual([]);
  });
});

describe("reconcile: purity", () => {
  test("is total and side-effect free on empty input", () => {
    expect(reconcile({ workspaces: [], pairs: [] }, { groups: [] })).toEqual([]);
  });

  test("does not mutate its inputs", () => {
    const d = desired();
    const o = { groups: [group({ chromeWindowId: "CH2" })] };
    const snapshot = JSON.stringify({ d, o });
    reconcile(d, o);
    expect(JSON.stringify({ d, o })).toBe(snapshot);
  });
});
