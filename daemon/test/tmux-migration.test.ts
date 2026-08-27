import { describe, expect, test } from "bun:test";
import { emptyMigrationPlan, planMigration, type LegacyTmuxSyncState } from "../src/tmux-migration.ts";

describe("planMigration", () => {
  test("reclassifies a single-window session mapping", () => {
    const legacy: LegacyTmuxSyncState = { "win-1": { compliance: "cmux-uuid-a" } };
    const sessionsByName = new Map([["compliance", "$2"]]);
    const plan = planMigration(legacy, sessionsByName);
    expect(plan.reclassify).toEqual([{ cmuxSourceId: "cmux-uuid-a", sessionId: "$2", sessionName: "compliance" }]);
    expect(plan.archive).toEqual([]);
  });

  test("windows-mode fan-out: reclassifies the first window's tab, archives the rest", () => {
    const legacy: LegacyTmuxSyncState = {
      "win-1": { compliance: "cmux-uuid-a" },
      "win-2": { compliance: "cmux-uuid-b" },
      "win-3": { compliance: "cmux-uuid-c" },
    };
    const sessionsByName = new Map([["compliance", "$2"]]);
    const plan = planMigration(legacy, sessionsByName);
    expect(plan.reclassify).toHaveLength(1);
    expect(plan.reclassify[0]!.sessionId).toBe("$2");
    expect(plan.archive).toHaveLength(2);
    expect(plan.archive.every((a) => a.source === "cmux")).toBe(true);
    // the reclassified tab is never also archived
    const reclassifiedId = plan.reclassify[0]!.cmuxSourceId;
    expect(plan.archive.some((a) => a.cmuxSourceId === reclassifiedId)).toBe(false);
  });

  test("a session name with no live matching session is dropped entirely", () => {
    const legacy: LegacyTmuxSyncState = { "win-1": { "long-dead-session": "cmux-uuid-a" } };
    const plan = planMigration(legacy, new Map());
    expect(plan).toEqual(emptyMigrationPlan());
  });

  test("multiple distinct sessions each get their own reclassify entry", () => {
    const legacy: LegacyTmuxSyncState = {
      "win-1": { compliance: "cmux-uuid-a", wakey: "cmux-uuid-b" },
    };
    const sessionsByName = new Map([
      ["compliance", "$2"],
      ["wakey", "$36"],
    ]);
    const plan = planMigration(legacy, sessionsByName);
    expect(plan.reclassify).toHaveLength(2);
    expect(plan.archive).toEqual([]);
  });

  test("empty legacy state produces an empty plan", () => {
    expect(planMigration({}, new Map())).toEqual(emptyMigrationPlan());
  });
});
