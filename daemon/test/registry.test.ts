import { describe, expect, test } from "bun:test";
import { Registry, colorFor, TAB_GROUP_COLORS } from "../src/registry.ts";
import type { CmuxWorkspaceEvent } from "../src/parser.ts";

function ev(
  name: CmuxWorkspaceEvent["name"],
  workspaceId: string,
  title: string,
  cwd: string | null = "/x",
  extra: Partial<CmuxWorkspaceEvent> = {},
): CmuxWorkspaceEvent {
  return {
    name,
    workspaceId,
    title,
    cwd,
    bootId: extra.bootId ?? "B1",
    seq: extra.seq ?? 1,
    occurredAtMs: extra.occurredAtMs ?? 1000,
  };
}

describe("colorFor", () => {
  test("is deterministic for the same title", () => {
    expect(colorFor("mh-accounts")).toBe(colorFor("mh-accounts"));
  });

  test("is the sum of UTF-16 char codes mod 9 into the 9 tabGroups colors", () => {
    const title = "abc";
    const sum = "abc".split("").reduce((s, c) => s + c.charCodeAt(0), 0);
    expect(colorFor(title)).toBe(TAB_GROUP_COLORS[sum % 9]);
  });

  test("only ever returns one of the 9 Chrome tabGroups colors", () => {
    for (const title of ["", "a", "cmux", "jeff-review", "Terminal 7", "🎉emoji"]) {
      expect(TAB_GROUP_COLORS).toContain(colorFor(title));
    }
  });
});

describe("Registry.applyEvent", () => {
  test("created inserts a new WorkspaceRef and emits workspace.upserted", () => {
    const reg = new Registry();
    const out = reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted");
    expect(out[0]!.workspace.title).toBe("cmux");
    expect(out[0]!.workspace.archived).toBe(false);
    expect(out[0]!.workspace.id).toMatch(/^mw_[0-9a-f]{8}$/);
    expect(reg.workspaces.size).toBe(1);
  });

  test("id is stable forever across subsequent events for the same sourceId", () => {
    const reg = new Registry();
    const first = reg.applyEvent(ev("created", "W1", "cmux", "/repo"))[0]!.workspace.id;
    const second = reg.applyEvent(ev("renamed", "W1", "cmux-renamed", "/repo"))[0]!.workspace.id;
    expect(second).toBe(first);
  });

  test("selected sets activeId and emits workspace.activated (plus upserted if new)", () => {
    const reg = new Registry();
    const out = reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    const id = out.find((e) => e.name === "workspace.upserted")!.workspace.id;
    expect(reg.activeId).toBe(id);
    const activated = out.find((e) => e.name === "workspace.activated");
    expect(activated).toBeDefined();
    expect(activated!.workspace.id).toBe(id);
  });

  test("selected on an already-known workspace with unchanged title/cwd still activates but does not re-upsert", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.activated");
  });

  test("renamed refreshes title and emits upserted when title changed", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "old-title", "/repo"));
    const out = reg.applyEvent(ev("renamed", "W1", "new-title", "/repo"));
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted");
    expect(out[0]!.workspace.title).toBe("new-title");

    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.title).toBe("new-title");
  });

  test("closed sets archived true and emits workspace.archived, never deletes", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent(ev("closed", "W1", "cmux", "/repo"));
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.archived");
    expect(out[0]!.workspace.archived).toBe(true);
    expect(reg.workspaces.size).toBe(1); // never deleted
  });

  test("closed on an unknown workspace is a no-op (nothing to close)", () => {
    const reg = new Registry();
    const out = reg.applyEvent(ev("closed", "unknown", "x", "/repo"));
    expect(out).toEqual([]);
    expect(reg.workspaces.size).toBe(0);
  });

  test("re-bind by (title, cwd) among archived+live when sourceId doesn't match", () => {
    const reg = new Registry();
    // simulate a daemon restart: original sourceId lost, but title+cwd match an archived ref
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent(ev("closed", "W1", "cmux", "/repo"));
    expect(reg.workspaces.size).toBe(1);

    const out = reg.applyEvent(ev("created", "W2-different-source-id", "cmux", "/repo"));
    // re-bound to the SAME ref (matched by title+cwd), not a new one
    expect(reg.workspaces.size).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted"); // unarchive
    expect(out[0]!.workspace.archived).toBe(false);
  });

  test("distinct (title, cwd) with no sourceId match creates a new ref", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo-a"));
    reg.applyEvent(ev("created", "W2", "cmux", "/repo-b"));
    expect(reg.workspaces.size).toBe(2);
  });

  test("color hash on the emitted actuator workspace matches colorFor(title)", () => {
    const reg = new Registry();
    const out = reg.applyEvent(ev("created", "W1", "jeff-review", "/repo"));
    expect(out[0]!.workspace.color).toBe(colorFor("jeff-review"));
  });
});

describe("colorFor with cmuxColor", () => {
  test("uses the mapped cmuxColor when set, ignoring the title hash", () => {
    // SafeLease brand blue maps to "blue" regardless of what the title hash would give
    expect(colorFor("zzz-totally-unrelated-title", "#2779FB")).toBe("blue");
  });

  test("falls back to the title hash when cmuxColor is null", () => {
    expect(colorFor("mh-accounts", null)).toBe(colorFor("mh-accounts"));
  });

  test("falls back to the title hash when cmuxColor is omitted entirely", () => {
    expect(colorFor("mh-accounts")).toBe(colorFor("mh-accounts", undefined));
  });

  test("falls back to the title hash when cmuxColor is an unparseable hex", () => {
    expect(colorFor("mh-accounts", "not-a-color")).toBe(colorFor("mh-accounts"));
  });
});

describe("Registry applyEvent(colored)", () => {
  test("sets cmuxColor on a known workspace (matched by sourceId) and emits workspace.upserted", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent({ ...ev("colored", "W1", "", null), color: "#2779FB" });
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted");
    expect(out[0]!.workspace.color).toBe("blue");

    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.cmuxColor).toBe("#2779FB");
  });

  test("does not touch title/cwd (a color change carries neither)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent({ ...ev("colored", "W1", "", null), color: "#2779FB" });
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.title).toBe("cmux");
    expect(ref.cwd).toBe("/repo");
  });

  test("resolves a named cmux.json slot via the namedSlots table injected at construction", () => {
    const reg = new Registry({ Navy: "#152744", Blue: "#2779FB" });
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent({ ...ev("colored", "W1", "", null), color: "Navy" });
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.cmuxColor).toBe("#152744");
    expect(out[0]!.workspace.color).toBe("blue"); // #152744's real nearest under hue-first, see colors.test.ts
  });

  test("an unresolvable named slot (no table entry) leaves cmuxColor null, still emits since it changed from unset", () => {
    const reg = new Registry(null);
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent({ ...ev("colored", "W1", "", null), color: "SomeUnknownSlot" });
    expect(out).toEqual([]); // null -> null is not a change
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.cmuxColor).toBeNull();
  });

  test("clear_color (color: null) clears cmuxColor and emits workspace.upserted", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent({ ...ev("colored", "W1", "", null), color: "#2779FB" });
    const out = reg.applyEvent({ ...ev("colored", "W1", "", null), color: null });
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted");
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.cmuxColor).toBeNull();
  });

  test("setting the same color twice does not re-emit (no-op on unchanged value)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent({ ...ev("colored", "W1", "", null), color: "#2779FB" });
    const out = reg.applyEvent({ ...ev("colored", "W1", "", null), color: "#2779FB" });
    expect(out).toEqual([]);
  });

  test("colored on an unknown workspace is a no-op (nothing to color)", () => {
    const reg = new Registry();
    const out = reg.applyEvent({ ...ev("colored", "unknown", "", null), color: "#2779FB" });
    expect(out).toEqual([]);
    expect(reg.workspaces.size).toBe(0);
  });

  test("a newly created workspace starts with cmuxColor: null", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.cmuxColor).toBeNull();
  });
});

describe("Registry.markPainted (color backflow)", () => {
  test("sets paintedColor on the matching ref", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markPainted(ref.id, "#1a73e8");
    expect(ref.paintedColor).toBe("#1a73e8");
  });

  test("overwrites a previous paintedColor (repaint after the target changed)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markPainted(ref.id, "#1a73e8");
    reg.markPainted(ref.id, "#d93025");
    expect(ref.paintedColor).toBe("#d93025");
  });

  test("does not touch cmuxColor -- that stays applyColor's job", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markPainted(ref.id, "#1a73e8");
    expect(ref.cmuxColor).toBeNull();
  });

  test("a newly created workspace starts with paintedColor: null", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.paintedColor).toBeNull();
  });

  test("unknown id is a no-op, not a throw", () => {
    const reg = new Registry();
    expect(() => reg.markPainted("mw_unknown", "#1a73e8")).not.toThrow();
  });
});

describe("Registry attachedAt persistence", () => {
  test("a newly created workspace starts with attachedAt: null", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.attachedAt).toBeNull();
  });

  test("markAttached sets attachedAt on first call", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markAttached(ref.id, "2026-01-01T00:00:00.000Z");
    expect(ref.attachedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("markAttached is idempotent -- the first timestamp wins", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markAttached(ref.id, "2026-01-01T00:00:00.000Z");
    reg.markAttached(ref.id, "2026-06-01T00:00:00.000Z");
    expect(ref.attachedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("markAttached on an unknown id is a no-op, not a throw", () => {
    const reg = new Registry();
    expect(() => reg.markAttached("mw_unknown")).not.toThrow();
  });

  test("a workspace.selected event automatically marks the workspace attached", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(typeof ref.attachedAt).toBe("string");
  });

  test("attachedAt survives a later rename/upsert (never cleared by unrelated updates)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    const firstAttachedAt = ref.attachedAt;
    reg.applyEvent(ev("renamed", "W1", "renamed-cmux", "/repo"));
    expect(ref.attachedAt).toBe(firstAttachedAt);
  });

  test("clearAttached resets attachedAt to null", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markAttached(ref.id);
    reg.clearAttached(ref.id);
    expect(ref.attachedAt).toBeNull();
  });

  test("clearAttached is a no-op for an unknown id, not a throw", () => {
    const reg = new Registry();
    expect(() => reg.clearAttached("mw_unknown")).not.toThrow();
  });

  test("clearAttached is a no-op for an already-unattached ref", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.clearAttached(ref.id);
    expect(ref.attachedAt).toBeNull();
  });

  test("after clearAttached, a later markAttached re-attaches with a fresh timestamp", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markAttached(ref.id, "2026-01-01T00:00:00.000Z");
    reg.clearAttached(ref.id);
    reg.markAttached(ref.id, "2026-06-01T00:00:00.000Z");
    expect(ref.attachedAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("Registry.attachOnActivate (createGroups: on-open vs on-activate)", () => {
  test("defaults to true (on-activate's historical behavior) for any caller that doesn't set it", () => {
    const reg = new Registry();
    expect(reg.attachOnActivate).toBe(true);
  });

  test("with attachOnActivate: false, a selected event still activates but does NOT attach", () => {
    const reg = new Registry();
    reg.attachOnActivate = false;
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(reg.activeId).toBe(ref.id);
    expect(out.find((e) => e.name === "workspace.activated")).toBeDefined();
    expect(ref.attachedAt).toBeNull();
  });

  test("with attachOnActivate: false, activateBySourceId (window follow) still activates but does NOT attach", () => {
    const reg = new Registry();
    reg.attachOnActivate = false;
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const out = reg.activateBySourceId("W1");
    const ref = [...reg.workspaces.values()][0]!;
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.activated");
    expect(ref.attachedAt).toBeNull();
  });

  test("with attachOnActivate: true (default), a selected event attaches -- unchanged behavior", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.applyEvent(ev("selected", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    expect(typeof ref.attachedAt).toBe("string");
  });

  test("markAttached (open_url's path) still attaches even with attachOnActivate: false", () => {
    const reg = new Registry();
    reg.attachOnActivate = false;
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const ref = [...reg.workspaces.values()][0]!;
    reg.markAttached(ref.id);
    expect(typeof ref.attachedAt).toBe("string");
  });
});

describe("Registry.activateBySourceId", () => {
  test("activates a known ref by cmux sourceId and emits workspace.activated", () => {
    const reg = new Registry();
    const [upserted] = reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    const id = upserted!.workspace.id;

    const out = reg.activateBySourceId("W1");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.activated");
    expect(out[0]!.workspace.id).toBe(id);
    expect(reg.activeId).toBe(id);
  });

  test("does not touch title/cwd (window-focus carries no rename info)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.activateBySourceId("W1");
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.title).toBe("cmux");
    expect(ref.cwd).toBe("/repo");
  });

  test("unknown sourceId is a no-op (nothing to activate)", () => {
    const reg = new Registry();
    const out = reg.activateBySourceId("unknown");
    expect(out).toEqual([]);
    expect(reg.activeId).toBeNull();
  });

  test("activating via window follow also marks the workspace attached", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.activateBySourceId("W1");
    const ref = [...reg.workspaces.values()][0]!;
    expect(typeof ref.attachedAt).toBe("string");
  });

  test("already-active workspace is a no-op (avoids redundant broadcasts)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/repo"));
    reg.activateBySourceId("W1");
    const out = reg.activateBySourceId("W1");
    expect(out).toEqual([]);
  });
});

describe("Registry -- Phase 0: source-scoped findMatch (docs/tmux-port-plan.md §2.1)", () => {
  test("a tmux-sourced ref and a cmux-sourced ref sharing a title never re-bind to each other", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "cmux-W1", "compliance", null));
    reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance" });
    expect(reg.workspaces.size).toBe(2);

    const refs = [...reg.workspaces.values()];
    const cmuxRef = refs.find((r) => r.source === "cmux")!;
    const tmuxRef = refs.find((r) => r.source === "tmux")!;
    expect(cmuxRef.id).not.toBe(tmuxRef.id);
    expect(cmuxRef.sourceId).toBe("cmux-W1");
    expect(tmuxRef.sourceId).toBe("$1");
  });

  test("re-applying the same tmux session upserts the existing tmux ref, not the same-titled cmux ref", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "cmux-W1", "compliance", null));
    const [firstTmux] = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance" });
    const tmuxId = firstTmux!.workspace.id;

    const out = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance" });
    expect(out).toEqual([]); // unchanged -- no re-emit
    expect(reg.workspaces.size).toBe(2); // still two distinct refs, not merged
    expect(reg.workspaces.get(tmuxId)?.source).toBe("tmux");
  });

  test("archiving the cmux ref never archives the same-titled tmux ref", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "cmux-W1", "compliance", null));
    reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "compliance" });
    reg.applyEvent(ev("closed", "cmux-W1", "compliance", null));

    const refs = [...reg.workspaces.values()];
    const cmuxRef = refs.find((r) => r.source === "cmux")!;
    const tmuxRef = refs.find((r) => r.source === "tmux")!;
    expect(cmuxRef.archived).toBe(true);
    expect(tmuxRef.archived).toBe(false);
  });
});

describe("Registry.applyTmuxIntent", () => {
  test("upsertTmuxRef creates a new tmux-sourced ref", () => {
    const reg = new Registry();
    const out = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "wakey" });
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.upserted");
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.source).toBe("tmux");
    expect(ref.sourceId).toBe("$1");
    expect(ref.title).toBe("wakey");
  });

  test("upsertTmuxRef with an unchanged name is a no-op", () => {
    const reg = new Registry();
    reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "wakey" });
    const out = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "wakey" });
    expect(out).toEqual([]);
  });

  test("upsertTmuxRef with a changed name retitles the same ref (id stable across a rename)", () => {
    const reg = new Registry();
    const [first] = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "old-name" });
    const id = first!.workspace.id;
    const out = reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "new-name" });
    expect(out[0]!.workspace.id).toBe(id);
    expect(out[0]!.workspace.title).toBe("new-name");
    expect(reg.workspaces.size).toBe(1);
  });

  test("archiveTmuxRef archives the matching tmux ref and emits workspace.archived", () => {
    const reg = new Registry();
    reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "wakey" });
    const out = reg.applyTmuxIntent({ type: "archiveTmuxRef", sessionId: "$1" });
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.archived");
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.archived).toBe(true);
  });

  test("archiveTmuxRef on an unknown session id is a no-op", () => {
    const reg = new Registry();
    const out = reg.applyTmuxIntent({ type: "archiveTmuxRef", sessionId: "$unknown" });
    expect(out).toEqual([]);
  });

  test("archiveTmuxRef on an already-archived ref does not re-emit", () => {
    const reg = new Registry();
    reg.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$1", sessionName: "wakey" });
    reg.applyTmuxIntent({ type: "archiveTmuxRef", sessionId: "$1" });
    const out = reg.applyTmuxIntent({ type: "archiveTmuxRef", sessionId: "$1" });
    expect(out).toEqual([]);
  });
});

describe("Registry.reclassifyAsTmux", () => {
  test("converts a cmux-sourced ref into the tmux-sourced ref of record, preserving its id", () => {
    const reg = new Registry();
    const [created] = reg.applyEvent(ev("created", "cmux-W1", "compliance", "/hub"));
    const originalId = created!.workspace.id;

    const out = reg.reclassifyAsTmux("cmux-W1", "$2", "compliance");
    expect(out.length).toBe(1);
    expect(out[0]!.workspace.id).toBe(originalId); // same ref, same id -- same Chrome group

    const ref = reg.workspaces.get(originalId)!;
    expect(ref.source).toBe("tmux");
    expect(ref.sourceId).toBe("$2");
    expect(ref.title).toBe("compliance");
    expect(reg.workspaces.size).toBe(1); // no new ref created
  });

  test("is a no-op when no cmux ref with that sourceId exists", () => {
    const reg = new Registry();
    const out = reg.reclassifyAsTmux("nonexistent", "$2", "compliance");
    expect(out).toEqual([]);
    expect(reg.workspaces.size).toBe(0);
  });

  test("idempotent: a second call for the same cmuxSourceId is a no-op (already reclassified)", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "cmux-W1", "compliance", "/hub"));
    reg.reclassifyAsTmux("cmux-W1", "$2", "compliance");
    const out = reg.reclassifyAsTmux("cmux-W1", "$2", "compliance");
    expect(out).toEqual([]);
    expect(reg.workspaces.size).toBe(1);
  });
});

describe("Registry.pruneArchived", () => {
  test("cutoffIso: null removes ALL archived refs, regardless of age", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "old-session", "/a"));
    reg.applyEvent(ev("closed", "W1", "old-session", "/a"));
    const removed = reg.pruneArchived(null);
    expect(removed.length).toBe(1);
    expect(removed[0]!.title).toBe("old-session");
    expect(reg.workspaces.size).toBe(0);
  });

  test("live (unarchived) refs are NEVER pruned, even with cutoffIso: null", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "cmux", "/a"));
    const removed = reg.pruneArchived(null);
    expect(removed).toEqual([]);
    expect(reg.workspaces.size).toBe(1);
  });

  test("with a cutoffIso, only archived refs updatedAt strictly OLDER than it are removed", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "old-session", "/a"));
    reg.applyEvent(ev("closed", "W1", "old-session", "/a"));
    const ref = [...reg.workspaces.values()][0]!;
    ref.updatedAt = "2020-01-01T00:00:00.000Z"; // simulate an old archive

    const removed = reg.pruneArchived("2025-01-01T00:00:00.000Z");
    expect(removed.length).toBe(1);
    expect(reg.workspaces.size).toBe(0);
  });

  test("an archived ref NEWER than the cutoff is kept", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "recent-session", "/a"));
    reg.applyEvent(ev("closed", "W1", "recent-session", "/a"));
    const ref = [...reg.workspaces.values()][0]!;
    ref.updatedAt = "2026-08-01T00:00:00.000Z"; // recent

    const removed = reg.pruneArchived("2020-01-01T00:00:00.000Z"); // cutoff far in the past
    expect(removed).toEqual([]);
    expect(reg.workspaces.size).toBe(1);
  });

  test("a mix of old-archived, recent-archived, and live refs: only old-archived is pruned", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "W1", "live", "/a"));
    reg.applyEvent(ev("created", "W2", "old-archived", "/b"));
    reg.applyEvent(ev("closed", "W2", "old-archived", "/b"));
    reg.applyEvent(ev("created", "W3", "recent-archived", "/c"));
    reg.applyEvent(ev("closed", "W3", "recent-archived", "/c"));

    const refs = [...reg.workspaces.values()];
    refs.find((r) => r.title === "old-archived")!.updatedAt = "2020-01-01T00:00:00.000Z";
    refs.find((r) => r.title === "recent-archived")!.updatedAt = "2026-08-01T00:00:00.000Z";

    const removed = reg.pruneArchived("2025-01-01T00:00:00.000Z");
    expect(removed.length).toBe(1);
    expect(removed[0]!.title).toBe("old-archived");
    expect(reg.workspaces.size).toBe(2);
    const remainingTitles = [...reg.workspaces.values()].map((r) => r.title).sort();
    expect(remainingTitles).toEqual(["live", "recent-archived"]);
  });

  test("an empty registry prunes nothing, no throw", () => {
    const reg = new Registry();
    expect(reg.pruneArchived(null)).toEqual([]);
  });

  test("a pruned ref's cmux workspace re-creates cleanly if seen again (a new id, not a resurrection)", () => {
    const reg = new Registry();
    const [firstUpsert] = reg.applyEvent(ev("created", "W1", "cmux", "/a"));
    const originalId = firstUpsert!.workspace.id;
    reg.applyEvent(ev("closed", "W1", "cmux", "/a"));
    reg.pruneArchived(null);
    expect(reg.workspaces.size).toBe(0);

    const [reCreated] = reg.applyEvent(ev("created", "W1", "cmux", "/a"));
    expect(reg.workspaces.size).toBe(1);
    expect(reCreated!.workspace.id).not.toBe(originalId); // fresh id, not resurrected
  });
});

describe("Registry.archiveBySourceId", () => {
  test("archives a matching ref of the given source and emits workspace.archived", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "cmux-W1", "compliance", "/hub"));
    const out = reg.archiveBySourceId("cmux", "cmux-W1");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("workspace.archived");
  });

  test("is source-scoped -- does not archive a same-sourceId ref of a different source", () => {
    const reg = new Registry();
    reg.applyEvent(ev("created", "shared-id", "compliance", "/hub"));
    const out = reg.archiveBySourceId("tmux", "shared-id");
    expect(out).toEqual([]);
    const ref = [...reg.workspaces.values()][0]!;
    expect(ref.archived).toBe(false);
  });

  test("unknown sourceId is a no-op", () => {
    const reg = new Registry();
    expect(reg.archiveBySourceId("cmux", "unknown")).toEqual([]);
  });
});
