import { describe, expect, test } from "bun:test";
import { resolveTarget } from "../automation.js";

function byId(entries) {
  return entries;
}

describe("resolveTarget -- workspace-scoped tab resolution", () => {
  test("no entry for the identity at all -- refused", () => {
    const out = resolveTarget({}, "t_unknown", [], null);
    expect(out.ok).toBe(false);
  });

  test("entry exists but has no group (never attached) -- refused", () => {
    const out = resolveTarget({ t_a: { groupId: null } }, "t_a", [], null);
    expect(out.ok).toBe(false);
  });

  test("group exists but has zero tabs -- refused", () => {
    const out = resolveTarget({ t_a: { groupId: 5 } }, "t_a", [], null);
    expect(out.ok).toBe(false);
  });

  test("no requested tabId -- defaults to the active tab in the group", () => {
    const tabs = [
      { id: 1, active: false },
      { id: 2, active: true },
    ];
    const out = resolveTarget({ t_a: { groupId: 5 } }, "t_a", tabs, null);
    expect(out).toEqual({ ok: true, tabId: 2 });
  });

  test("no requested tabId, no active tab -- defaults to the first tab", () => {
    const tabs = [
      { id: 1, active: false },
      { id: 2, active: false },
    ];
    const out = resolveTarget({ t_a: { groupId: 5 } }, "t_a", tabs, null);
    expect(out).toEqual({ ok: true, tabId: 1 });
  });

  test("a requested tabId that IS in the group's tabs is honored", () => {
    const tabs = [
      { id: 1, active: true },
      { id: 2, active: false },
    ];
    const out = resolveTarget({ t_a: { groupId: 5 } }, "t_a", tabs, 2);
    expect(out).toEqual({ ok: true, tabId: 2 });
  });

  test("a requested tabId NOT in the group's tabs -- refused (the scoping enforcement)", () => {
    const tabs = [{ id: 1, active: true }];
    const out = resolveTarget({ t_a: { groupId: 5 } }, "t_a", tabs, 999);
    expect(out.ok).toBe(false);
  });

  test("a tabId belonging to a DIFFERENT identity's group is refused even if it exists elsewhere", () => {
    // simulates the caller passing tabsInGroup for identity A, while the
    // requested tabId actually lives in identity B's group -- it simply
    // won't be found in A's tab list.
    const tabsForA = [{ id: 10, active: true }];
    const out = resolveTarget({ t_a: { groupId: 5 }, t_b: { groupId: 6 } }, "t_a", tabsForA, 20 /* belongs to B */);
    expect(out.ok).toBe(false);
  });
});
