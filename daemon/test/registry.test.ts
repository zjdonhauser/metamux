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
