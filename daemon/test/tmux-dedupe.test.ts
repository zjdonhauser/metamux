import { describe, expect, test } from "bun:test";
import { Registry } from "../src/registry.ts";

// Fixtures mirror the live incident registry of 2026-08-27: one tmux session
// ("compliance", tmux id "$2") represented by SEVEN live tmux-sourced refs
// with sourceId "$2" (one minted per daemon restart) plus one tmux ref whose
// sourceId is a cmux workspace UUID (the first migration's product) carrying
// the real attachedAt/placementOverride history, plus one live cmux-sourced
// shadow resurrected by seed-replay.

function seedIncidentShape(registry: Registry): void {
  // The history-bearing ref (UUID-flavored sourceId, migration-era).
  registry.applyTmuxIntent({
    type: "upsertTmuxRef",
    sessionId: "0CF5CF2D-FFB0-41ED-9735-A78A2AA28B79",
    sessionName: "compliance",
    cmuxWindowId: "WIN-91FB",
  });
  const historyRef = [...registry.workspaces.values()].find(
    (w) => w.sourceId === "0CF5CF2D-FFB0-41ED-9735-A78A2AA28B79",
  )!;
  registry.markAttached(historyRef.id, "2026-08-27T19:47:16.165Z");
  historyRef.placementOverride = "287029199";

  // Restart-minted duplicates, all (tmux, "$2").
  for (let i = 0; i < 3; i++) {
    const before = registry.workspaces.size;
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$2", sessionName: "compliance" });
    // Simulate the live bug's outcome when upsert re-binding failed: force a
    // fresh duplicate if the intent re-bound instead (the repair must handle
    // the on-disk shape regardless of how it arose).
    if (registry.workspaces.size === before) {
      const dup = registry.applyEvent({
        name: "created",
        workspaceId: `FORCE-DUP-${i}`,
        title: "compliance",
        cwd: null,
        bootId: "B1",
        seq: 100 + i,
        occurredAtMs: 100 + i,
      });
      void dup;
      const forced = [...registry.workspaces.values()].find((w) => w.sourceId === `FORCE-DUP-${i}`)!;
      forced.source = "tmux";
      forced.sourceId = "$2";
      forced.cwd = null;
    }
  }
}

describe("Registry.dedupeTmuxRefs -- collapses duplicate live tmux refs", () => {
  test("keeps one ref per tmux session title, preserving attachment/override history", () => {
    const registry = new Registry();
    seedIncidentShape(registry);

    const liveBefore = [...registry.workspaces.values()].filter((w) => !w.archived && w.source === "tmux");
    expect(liveBefore.length).toBeGreaterThanOrEqual(3);

    const result = registry.dedupeTmuxRefs();

    const liveAfter = [...registry.workspaces.values()].filter(
      (w) => !w.archived && w.source === "tmux" && w.title === "compliance",
    );
    expect(liveAfter.length).toBe(1);
    const keeper = liveAfter[0]!;
    // History fields survive the merge.
    expect(keeper.attachedAt).toBe("2026-08-27T19:47:16.165Z");
    expect(keeper.placementOverride).toBe("287029199");
    // The keeper adopts the $N-shaped sourceId so reconcile re-binds forever after.
    expect(keeper.sourceId).toBe("$2");
    expect(result.archived).toBeGreaterThanOrEqual(2);
  });

  test("is a no-op on a clean registry (idempotent)", () => {
    const registry = new Registry();
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$5", sessionName: "amplify" });
    const first = registry.dedupeTmuxRefs();
    const second = registry.dedupeTmuxRefs();
    expect(first.archived).toBe(0);
    expect(second.archived).toBe(0);
  });
});

describe("Registry.reclassifyAsTmux -- shadow guard", () => {
  test("archives the cmux shadow instead of minting a duplicate when a live tmux ref exists", () => {
    const registry = new Registry();
    // The real tmux ref of record.
    registry.applyTmuxIntent({ type: "upsertTmuxRef", sessionId: "$2", sessionName: "compliance" });
    // Seed-replay resurrects the absorbed cmux workspace as a live cmux ref.
    registry.applyEvent({
      name: "created",
      workspaceId: "CMUX-UUID-RESURRECTED",
      title: "compliance",
      cwd: "/Users/zachary",
      bootId: "B2",
      seq: 5,
      occurredAtMs: 5,
    });

    // The migration re-runs on restart and tries to reclassify the shadow.
    const events = registry.reclassifyAsTmux("CMUX-UUID-RESURRECTED", "$2", "compliance");

    const liveTmux = [...registry.workspaces.values()].filter(
      (w) => !w.archived && w.source === "tmux" && w.sourceId === "$2",
    );
    expect(liveTmux.length).toBe(1); // no duplicate minted
    const shadow = [...registry.workspaces.values()].find((w) => w.sourceId === "CMUX-UUID-RESURRECTED")!;
    expect(shadow.archived).toBe(true); // shadow archived, not reclassified
    expect(events.some((e) => e.name === "workspace.archived")).toBe(true);
  });
});
