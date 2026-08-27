import { describe, expect, test } from "bun:test";
import { diffConfig, HOT_APPLICABLE_CONFIG_KEYS } from "../src/config-diff.ts";
import { DEFAULT_CONFIG, type MetamuxConfig } from "../src/config.ts";

function cfg(overrides: Partial<MetamuxConfig> = {}): MetamuxConfig {
  return {
    ...DEFAULT_CONFIG,
    ports: { ...DEFAULT_CONFIG.ports },
    ...overrides,
  };
}

describe("diffConfig", () => {
  test("identical configs produce no changes", () => {
    expect(diffConfig(cfg(), cfg())).toEqual([]);
  });

  test("detects a top-level scalar change (reverseSync) and marks it hot-applicable", () => {
    const changes = diffConfig(cfg({ reverseSync: false }), cfg({ reverseSync: true }));
    expect(changes).toEqual([{ key: "reverseSync", oldValue: false, newValue: true, hotApplicable: true }]);
  });

  test("detects collapseOthers, closeBehavior, debounceMs as hot-applicable", () => {
    const oldConfig = cfg({ collapseOthers: true, closeBehavior: "archive", debounceMs: 200 });
    const newConfig = cfg({ collapseOthers: false, closeBehavior: "close", debounceMs: 500 });
    const changes = diffConfig(oldConfig, newConfig);
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey.collapseOthers?.hotApplicable).toBe(true);
    expect(byKey.closeBehavior?.hotApplicable).toBe(true);
    expect(byKey.debounceMs?.hotApplicable).toBe(true);
  });

  test("detects nested ports.mode / ports.maxPort changes as hot-applicable", () => {
    const oldConfig = cfg({ ports: { mode: "auto", ignore: [], maxPort: 49151 } });
    const newConfig = cfg({ ports: { mode: "notify", ignore: [], maxPort: 8000 } });
    const changes = diffConfig(oldConfig, newConfig);
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey["ports.mode"]).toEqual({ key: "ports.mode", oldValue: "auto", newValue: "notify", hotApplicable: true });
    expect(byKey["ports.maxPort"]).toEqual({
      key: "ports.maxPort",
      oldValue: 49151,
      newValue: 8000,
      hotApplicable: true,
    });
  });

  test("detects ports.ignore array changes by deep equality, not reference", () => {
    const oldConfig = cfg({ ports: { mode: "auto", ignore: [22, 5432], maxPort: 49151 } });
    const sameContents = cfg({ ports: { mode: "auto", ignore: [22, 5432], maxPort: 49151 } });
    expect(diffConfig(oldConfig, sameContents)).toEqual([]); // different array instance, same contents -> no change

    const changedContents = cfg({ ports: { mode: "auto", ignore: [22, 3000], maxPort: 49151 } });
    const changes = diffConfig(oldConfig, changedContents);
    expect(changes.length).toBe(1);
    expect(changes[0]!.key).toBe("ports.ignore");
    expect(changes[0]!.hotApplicable).toBe(true);
  });

  test("port and eventsPath changes are detected but marked NOT hot-applicable", () => {
    const changes = diffConfig(cfg({ port: 8377 }), cfg({ port: 9999 }));
    expect(changes).toEqual([{ key: "port", oldValue: 8377, newValue: 9999, hotApplicable: false }]);
  });

  test("eventsPath change is NOT hot-applicable", () => {
    const changes = diffConfig(
      cfg({ eventsPath: "~/.cmuxterm/events.jsonl" }),
      cfg({ eventsPath: "~/.cmuxterm/other.jsonl" }),
    );
    expect(changes).toEqual([
      { key: "eventsPath", oldValue: "~/.cmuxterm/events.jsonl", newValue: "~/.cmuxterm/other.jsonl", hotApplicable: false },
    ]);
  });

  test("multiple simultaneous changes are all reported independently", () => {
    const oldConfig = cfg({ port: 8377, reverseSync: false, debounceMs: 200 });
    const newConfig = cfg({ port: 9999, reverseSync: true, debounceMs: 200 });
    const changes = diffConfig(oldConfig, newConfig);
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey.port?.hotApplicable).toBe(false);
    expect(byKey.reverseSync?.hotApplicable).toBe(true);
    expect(byKey.debounceMs).toBeUndefined(); // unchanged, not reported
  });

  test("HOT_APPLICABLE_CONFIG_KEYS matches exactly the spec'd set", () => {
    const actual: string[] = [...HOT_APPLICABLE_CONFIG_KEYS].sort();
    const expected: string[] = [
      "closeBehavior",
      "collapseOthers",
      "createGroups",
      "debounceMs",
      "groupBy",
      "ports.ignore",
      "ports.maxPort",
      "ports.mode",
      "reverseSync",
      "tmux.enabled",
      "tmux.mirror",
      "tmux.alphabetize",
      "tmux.reattachGraceMs",
      "tmux.spawnCwd",
      "janitor",
      "colorBackflow",
    ].sort();
    expect(actual).toEqual(expected);
  });

  test("groupBy and createGroups changes are detected and hot-applicable", () => {
    const oldConfig = cfg({ groupBy: "title", createGroups: "on-activate" });
    const newConfig = cfg({ groupBy: "workspace", createGroups: "eager" });
    const changes = diffConfig(oldConfig, newConfig);
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey.groupBy).toEqual({ key: "groupBy", oldValue: "title", newValue: "workspace", hotApplicable: true });
    expect(byKey.createGroups).toEqual({
      key: "createGroups",
      oldValue: "on-activate",
      newValue: "eager",
      hotApplicable: true,
    });
  });
});
