import { describe, expect, test } from "bun:test";
import { GroupProjection, titleAliasId, type GroupProjectionSnapshot } from "../src/group-projection.ts";
import type { ActuatorEvent, WorkspaceRef } from "../src/registry.ts";

function ref(overrides: Partial<WorkspaceRef> = {}): WorkspaceRef {
  return {
    id: overrides.id ?? "mw_00000001",
    title: overrides.title ?? "cmux",
    cwd: overrides.cwd ?? "/repo",
    source: "cmux",
    sourceId: overrides.sourceId ?? "SRC-1",
    archived: overrides.archived ?? false,
    cmuxColor: overrides.cmuxColor ?? null,
    attachedAt: overrides.attachedAt ?? null,
    paintedColor: overrides.paintedColor ?? null,
    paletteIndex: overrides.paletteIndex ?? null,
    cmuxWindowId: overrides.cmuxWindowId ?? null,
    placementOverride: overrides.placementOverride ?? null,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

function snapshot(workspaces: WorkspaceRef[], activeId: string | null = null): GroupProjectionSnapshot {
  return { workspaces, activeId };
}

function upserted(workspace: ReturnType<typeof ref>): ActuatorEvent {
  return { name: "workspace.upserted", workspace: { id: workspace.id, title: workspace.title, color: "blue", archived: workspace.archived } };
}

function activated(workspace: WorkspaceRef): ActuatorEvent {
  return { name: "workspace.activated", workspace: { id: workspace.id, title: workspace.title, color: "blue", archived: workspace.archived } };
}

function archivedEvent(workspace: WorkspaceRef): ActuatorEvent {
  return { name: "workspace.archived", workspace: { id: workspace.id, title: workspace.title, color: "blue", archived: true } };
}

describe("titleAliasId", () => {
  test("is deterministic for the same title", () => {
    expect(titleAliasId("cmux")).toBe(titleAliasId("cmux"));
  });

  test("is 't_' + 8 hex chars", () => {
    expect(titleAliasId("cmux")).toMatch(/^t_[0-9a-f]{8}$/);
  });

  test("different titles produce different ids (no accidental collision for common titles)", () => {
    const ids = new Set(["cmux", "compliance", "plugins", "Terminal 1", "jeff-review"].map(titleAliasId));
    expect(ids.size).toBe(5);
  });
});

describe("GroupProjection -- workspace mode (pass-through, unchanged behavior)", () => {
  test("project() returns the raw event unchanged", () => {
    const gp = new GroupProjection("workspace");
    const r = ref();
    const raw = upserted(r);
    expect(gp.project(raw, snapshot([r]))).toEqual([raw]);
  });

  test("projectState() returns one identity per real workspace, ids unchanged", () => {
    const gp = new GroupProjection("workspace");
    const a = ref({ id: "mw_a", title: "cmux", sourceId: "SRC-A" });
    const b = ref({ id: "mw_b", title: "cmux", sourceId: "SRC-B" }); // same title, different workspace
    const state = gp.projectState(snapshot([a, b], "mw_a"));
    expect(state.workspaces.map((w) => w.id).sort()).toEqual(["mw_a", "mw_b"]);
    expect(state.activeId).toBe("mw_a");
  });

  test("resolveIdentityToWorkspaceId returns the id itself if known, else null", () => {
    const gp = new GroupProjection("workspace");
    const a = ref({ id: "mw_a" });
    expect(gp.resolveIdentityToWorkspaceId("mw_a", snapshot([a]))).toBe("mw_a");
    expect(gp.resolveIdentityToWorkspaceId("mw_unknown", snapshot([a]))).toBeNull();
  });

  test("currentActiveIdentity returns registry's activeId unchanged", () => {
    const gp = new GroupProjection("workspace");
    expect(gp.currentActiveIdentity(snapshot([ref({ id: "mw_a" })], "mw_a"))).toBe("mw_a");
  });
});

describe("GroupProjection -- title mode: dedupe and aggregation", () => {
  test("two same-title workspaces project to ONE alias identity", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", sourceId: "SRC-A" });
    const b = ref({ id: "mw_b", title: "cmux", sourceId: "SRC-B" });
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces.length).toBe(1);
    expect(state.workspaces[0]!.id).toBe(titleAliasId("cmux"));
    expect(state.workspaces[0]!.title).toBe("cmux");
  });

  test("distinct titles still produce distinct identities", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "compliance" });
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces.length).toBe(2);
  });

  test("activated on ANY member reports the alias as activated", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    const events = gp.project(activated(b), snapshot([a, b], "mw_b"));
    expect(events.some((e) => e.name === "workspace.activated" && e.workspace.id === titleAliasId("cmux"))).toBe(true);
  });

  test("currentActiveIdentity maps the real active member to its alias", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    expect(gp.currentActiveIdentity(snapshot([a, b], "mw_b"))).toBe(titleAliasId("cmux"));
  });

  test("archived is emitted only when ALL members of the title are archived", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", archived: false });
    const b = ref({ id: "mw_b", title: "cmux", archived: true });
    // b alone archives -- a is still live, no archived event for the alias
    const eventsPartial = gp.project(archivedEvent(b), snapshot([a, b]));
    expect(eventsPartial.some((e) => e.name === "workspace.archived")).toBe(false);

    // now a also archives -- ALL members archived, alias goes archived
    const aArchived = { ...a, archived: true };
    const eventsAll = gp.project(archivedEvent(aArchived), snapshot([aArchived, b]));
    expect(eventsAll.some((e) => e.name === "workspace.archived" && e.workspace.id === titleAliasId("cmux"))).toBe(true);
  });

  test("upserted dedupes: an unrelated field change on one member that doesn't change the aggregate emits nothing new", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    // first sighting establishes the alias
    const first = gp.project(upserted(a), snapshot([a, b]));
    expect(first.some((e) => e.name === "workspace.upserted")).toBe(true);
    // b upserts too, but the aggregate (title/color/archived) is unchanged -- no new upserted
    const second = gp.project(upserted(b), snapshot([a, b]));
    expect(second.some((e) => e.name === "workspace.upserted")).toBe(false);
  });

  test("colorFor uses the first non-null cmuxColor among LIVE members, else title hash", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", cmuxColor: null });
    const b = ref({ id: "mw_b", title: "cmux", cmuxColor: "#2779FB" }); // -> blue
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces[0]!.color).toBe("blue");
  });

  test("an archived member's cmuxColor is NOT used even if it's the only non-null one", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", cmuxColor: null, archived: false });
    const b = ref({ id: "mw_b", title: "cmux", cmuxColor: "#2779FB", archived: true }); // archived, excluded
    const state = gp.projectState(snapshot([a, b]));
    // falls back to title hash since the only colored member is archived
    const expectedFallback = state.workspaces[0]!.color;
    expect(expectedFallback).not.toBe("blue"); // would be "blue" if b's color leaked through
  });

  const TEST_PALETTE = [
    { name: "Navy", hex: "#152744", chromeColor: "grey" as const },
    { name: "Blue", hex: "#2779FB", chromeColor: "blue" as const },
  ];

  test("colorMode: palette -- the alias picks up the first LIVE member's palette allocation", () => {
    const gp = new GroupProjection("title", "palette", TEST_PALETTE);
    const a = ref({ id: "mw_a", title: "cmux", paletteIndex: null });
    const b = ref({ id: "mw_b", title: "cmux", paletteIndex: 0 });
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces[0]!.color).toBe("grey"); // TEST_PALETTE[0]'s chromeColor, not hue-mapped
  });

  test("colorMode: palette -- an archived member's allocation is NOT used", () => {
    const gp = new GroupProjection("title", "palette", TEST_PALETTE);
    const a = ref({ id: "mw_a", title: "cmux", paletteIndex: null, archived: false });
    const b = ref({ id: "mw_b", title: "cmux", paletteIndex: 0, archived: true });
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces[0]!.color).not.toBe("grey");
  });

  test("colorMode: palette -- a genuinely user-set color on any live member still wins over the allocation", () => {
    const gp = new GroupProjection("title", "palette", TEST_PALETTE);
    const a = ref({ id: "mw_a", title: "cmux", paletteIndex: 0, cmuxColor: null });
    const b = ref({ id: "mw_b", title: "cmux", paletteIndex: null, cmuxColor: "#2779FB", paintedColor: null });
    const state = gp.projectState(snapshot([a, b]));
    expect(state.workspaces[0]!.color).toBe("blue"); // hue-mapped user color, not TEST_PALETTE[0]'s grey
  });

  test("groupBy: workspace -- resolveColor is applied per-ref directly, using its own paletteIndex", () => {
    const gp = new GroupProjection("workspace", "palette", TEST_PALETTE);
    const a = ref({ id: "mw_a", title: "cmux", paletteIndex: 0 });
    const state = gp.projectState(snapshot([a]));
    expect(state.workspaces[0]!.color).toBe("grey");
  });

  test("setColorMode switches live, mirroring setGroupBy", () => {
    const gp = new GroupProjection("title", "hash", TEST_PALETTE);
    const a = ref({ id: "mw_a", title: "cmux", paletteIndex: 0 });
    expect(gp.projectState(snapshot([a])).workspaces[0]!.color).not.toBe("grey"); // hash mode ignores the allocation
    gp.setColorMode("palette");
    expect(gp.projectState(snapshot([a])).workspaces[0]!.color).toBe("grey");
  });

  test("no live members with a color falls back to title hash", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "zzz-unlikely-title-xyz", cmuxColor: null });
    const state = gp.projectState(snapshot([a]));
    expect(state.workspaces[0]!.color).toBeDefined();
  });
});

describe("GroupProjection -- title mode: rename moves a member between buckets", () => {
  test("renaming a workspace out of a solo bucket archives the OLD alias and upserts the NEW one", () => {
    const gp = new GroupProjection("title");
    const original = ref({ id: "mw_a", title: "old-title" });
    // establish the old bucket first
    gp.project(upserted(original), snapshot([original]));

    // now the ref has been renamed in the registry -- snapshot reflects the NEW title
    const renamed = { ...original, title: "new-title" };
    const renameEvent: ActuatorEvent = {
      name: "workspace.upserted",
      workspace: { id: renamed.id, title: renamed.title, color: "blue", archived: false },
    };
    const events = gp.project(renameEvent, snapshot([renamed]));

    const oldBucketArchived = events.find((e) => e.name === "workspace.archived" && e.workspace.id === titleAliasId("old-title"));
    const newBucketUpserted = events.find((e) => e.name === "workspace.upserted" && e.workspace.id === titleAliasId("new-title"));
    expect(oldBucketArchived).toBeDefined();
    expect(newBucketUpserted).toBeDefined();
  });

  test("renaming a workspace out of a bucket that still has other members does NOT archive the old alias", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "shared-title" });
    const b = ref({ id: "mw_b", title: "shared-title" });
    gp.project(upserted(a), snapshot([a, b])); // establish the shared-title bucket

    const renamedA = { ...a, title: "renamed-away" };
    const renameEvent: ActuatorEvent = {
      name: "workspace.upserted",
      workspace: { id: renamedA.id, title: renamedA.title, color: "blue", archived: false },
    };
    const events = gp.project(renameEvent, snapshot([renamedA, b]));

    const oldBucketArchived = events.find((e) => e.name === "workspace.archived" && e.workspace.id === titleAliasId("shared-title"));
    expect(oldBucketArchived).toBeUndefined(); // b is still there, bucket survives
  });

  test("a first-sighting event (no prior known title) is not treated as a rename", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "brand-new" });
    const events = gp.project(upserted(a), snapshot([a]));
    // only the new bucket's upsert, no spurious archived-old-bucket event
    expect(events.length).toBe(1);
    expect(events[0]!.name).toBe("workspace.upserted");
  });
});

describe("GroupProjection -- identityFor / resolveIdentityToWorkspaceId (title mode)", () => {
  test("identityFor returns the alias identity for a member ref", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    const identity = gp.identityFor(a, snapshot([a, b]));
    expect(identity.id).toBe(titleAliasId("cmux"));
  });

  test("resolveIdentityToWorkspaceId maps an alias id back to a representative LIVE member", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", archived: true });
    const b = ref({ id: "mw_b", title: "cmux", archived: false });
    const resolved = gp.resolveIdentityToWorkspaceId(titleAliasId("cmux"), snapshot([a, b]));
    expect(resolved).toBe("mw_b"); // the live one, not the archived one
  });

  test("resolveIdentityToWorkspaceId prefers the currently ACTIVE member when one exists", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    const resolved = gp.resolveIdentityToWorkspaceId(titleAliasId("cmux"), snapshot([a, b], "mw_b"));
    expect(resolved).toBe("mw_b");
  });

  test("resolveIdentityToWorkspaceId returns null for an unknown alias id", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    expect(gp.resolveIdentityToWorkspaceId("t_deadbeef", snapshot([a]))).toBeNull();
  });
});

describe("GroupProjection.membersOf (detach-on-close)", () => {
  test("workspace mode: returns the id itself when it exists", () => {
    const gp = new GroupProjection("workspace");
    const a = ref({ id: "mw_a", title: "cmux" });
    expect(gp.membersOf("mw_a", snapshot([a]))).toEqual(["mw_a"]);
  });

  test("workspace mode: returns [] for an unknown id", () => {
    const gp = new GroupProjection("workspace");
    expect(gp.membersOf("mw_unknown", snapshot([]))).toEqual([]);
  });

  test("title mode: returns every real workspace sharing the alias's title", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    const c = ref({ id: "mw_c", title: "other" });
    const members = gp.membersOf(titleAliasId("cmux"), snapshot([a, b, c]));
    expect(members.sort()).toEqual(["mw_a", "mw_b"]);
  });

  test("title mode: includes archived members too (a close detaches the whole alias)", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux", archived: false });
    const b = ref({ id: "mw_b", title: "cmux", archived: true });
    const members = gp.membersOf(titleAliasId("cmux"), snapshot([a, b]));
    expect(members.sort()).toEqual(["mw_a", "mw_b"]);
  });

  test("title mode: returns [] for an alias id with no current members", () => {
    const gp = new GroupProjection("title");
    const a = ref({ id: "mw_a", title: "cmux" });
    expect(gp.membersOf("t_deadbeef", snapshot([a]))).toEqual([]);
  });
});

describe("GroupProjection -- setGroupBy (hot-reload)", () => {
  test("switching from workspace to title mode changes projectState's output shape", () => {
    const gp = new GroupProjection("workspace");
    const a = ref({ id: "mw_a", title: "cmux" });
    const b = ref({ id: "mw_b", title: "cmux" });
    expect(gp.projectState(snapshot([a, b])).workspaces.length).toBe(2);

    gp.setGroupBy("title");
    expect(gp.projectState(snapshot([a, b])).workspaces.length).toBe(1);
  });
});
