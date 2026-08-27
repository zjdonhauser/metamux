import { describe, expect, test } from "bun:test";
import {
  CONFIG_ALLOWED_KEYS,
  describeEffectiveConfig,
  getNestedValue,
  isAllowedConfigKey,
  parseConfigValue,
  setNestedValue,
  validateConfigValue,
} from "../src/config-cli.ts";

describe("parseConfigValue", () => {
  test("parses JSON booleans and numbers", () => {
    expect(parseConfigValue("true")).toBe(true);
    expect(parseConfigValue("false")).toBe(false);
    expect(parseConfigValue("8377")).toBe(8377);
    expect(parseConfigValue("49151")).toBe(49151);
  });

  test("parses JSON arrays", () => {
    expect(parseConfigValue("[22,5432]")).toEqual([22, 5432]);
  });

  test("falls back to a raw string when not valid JSON", () => {
    expect(parseConfigValue("off")).toBe("off");
    expect(parseConfigValue("archive")).toBe("archive");
    expect(parseConfigValue("auto")).toBe("auto");
  });

  test("a quoted JSON string parses to the unquoted string", () => {
    expect(parseConfigValue('"hello"')).toBe("hello");
  });
});

describe("isAllowedConfigKey", () => {
  test("accepts every key in the allowlist", () => {
    for (const key of CONFIG_ALLOWED_KEYS) {
      expect(isAllowedConfigKey(key)).toBe(true);
    }
  });

  test("rejects keys outside the allowlist", () => {
    expect(isAllowedConfigKey("eventsPath")).toBe(false);
    expect(isAllowedConfigKey("ports.bogus")).toBe(false);
    expect(isAllowedConfigKey("")).toBe(false);
    expect(isAllowedConfigKey("__proto__")).toBe(false);
  });

  test("groupBy and createGroups are allowed keys", () => {
    expect(isAllowedConfigKey("groupBy")).toBe(true);
    expect(isAllowedConfigKey("createGroups")).toBe(true);
  });
});

describe("validateConfigValue", () => {
  test("port and debounceMs and ports.maxPort require numbers", () => {
    expect(validateConfigValue("port", 8377).ok).toBe(true);
    expect(validateConfigValue("port", "8377").ok).toBe(false);
    expect(validateConfigValue("debounceMs", 300).ok).toBe(true);
    expect(validateConfigValue("debounceMs", true).ok).toBe(false);
    expect(validateConfigValue("ports.maxPort", 49151).ok).toBe(true);
    expect(validateConfigValue("ports.maxPort", "49151").ok).toBe(false);
  });

  test("reverseSync and collapseOthers require booleans", () => {
    expect(validateConfigValue("reverseSync", true).ok).toBe(true);
    expect(validateConfigValue("reverseSync", "true").ok).toBe(false);
    expect(validateConfigValue("collapseOthers", false).ok).toBe(true);
    expect(validateConfigValue("collapseOthers", 0).ok).toBe(false);
  });

  test("closeBehavior only accepts archive or close", () => {
    expect(validateConfigValue("closeBehavior", "archive").ok).toBe(true);
    expect(validateConfigValue("closeBehavior", "close").ok).toBe(true);
    expect(validateConfigValue("closeBehavior", "delete").ok).toBe(false);
  });

  test("ports.mode only accepts auto/notify/off", () => {
    expect(validateConfigValue("ports.mode", "auto").ok).toBe(true);
    expect(validateConfigValue("ports.mode", "notify").ok).toBe(true);
    expect(validateConfigValue("ports.mode", "off").ok).toBe(true);
    expect(validateConfigValue("ports.mode", "sometimes").ok).toBe(false);
  });

  test("ports.ignore requires an array of numbers", () => {
    expect(validateConfigValue("ports.ignore", [22, 5432]).ok).toBe(true);
    expect(validateConfigValue("ports.ignore", []).ok).toBe(true);
    expect(validateConfigValue("ports.ignore", [22, "x"]).ok).toBe(false);
    expect(validateConfigValue("ports.ignore", "22").ok).toBe(false);
  });

  test("groupBy only accepts title or workspace", () => {
    expect(validateConfigValue("groupBy", "title").ok).toBe(true);
    expect(validateConfigValue("groupBy", "workspace").ok).toBe(true);
    expect(validateConfigValue("groupBy", "sourceId").ok).toBe(false);
  });

  test("createGroups accepts on-open, on-activate, or eager", () => {
    expect(validateConfigValue("createGroups", "on-open").ok).toBe(true);
    expect(validateConfigValue("createGroups", "on-activate").ok).toBe(true);
    expect(validateConfigValue("createGroups", "eager").ok).toBe(true);
    expect(validateConfigValue("createGroups", "immediate").ok).toBe(false);
  });

  // Strict here: "lazy" is tolerated only when READING an existing config
  // file (config.ts's loadConfig back-compat), not for a fresh CLI write --
  // `metamux config set` should guide callers to the current vocabulary.
  test("createGroups rejects the legacy 'lazy' value on a fresh write", () => {
    expect(validateConfigValue("createGroups", "lazy").ok).toBe(false);
  });

  test("tmux.enabled and tmux.alphabetize require booleans", () => {
    expect(validateConfigValue("tmux.enabled", true).ok).toBe(true);
    expect(validateConfigValue("tmux.enabled", "true").ok).toBe(false);
    expect(validateConfigValue("tmux.alphabetize", false).ok).toBe(true);
    expect(validateConfigValue("tmux.alphabetize", 0).ok).toBe(false);
  });

  test("tmux.mirror only accepts windows or global", () => {
    expect(validateConfigValue("tmux.mirror", "windows").ok).toBe(true);
    expect(validateConfigValue("tmux.mirror", "global").ok).toBe(true);
    expect(validateConfigValue("tmux.mirror", "everywhere").ok).toBe(false);
  });

  test("tmux.reattachGraceMs requires a number", () => {
    expect(validateConfigValue("tmux.reattachGraceMs", 8000).ok).toBe(true);
    expect(validateConfigValue("tmux.reattachGraceMs", "8000").ok).toBe(false);
  });

  test("tmux.spawnCwd requires a non-empty string", () => {
    expect(validateConfigValue("tmux.spawnCwd", "~/Documents/GitHub").ok).toBe(true);
    expect(validateConfigValue("tmux.spawnCwd", "").ok).toBe(false);
    expect(validateConfigValue("tmux.spawnCwd", 123).ok).toBe(false);
  });

  test("colorBackflow requires a boolean", () => {
    expect(validateConfigValue("colorBackflow", true).ok).toBe(true);
    expect(validateConfigValue("colorBackflow", "true").ok).toBe(false);
  });

  test("pruneArchivedAfterDays requires a number >= 0, and accepts 0 (off)", () => {
    expect(validateConfigValue("pruneArchivedAfterDays", 7).ok).toBe(true);
    expect(validateConfigValue("pruneArchivedAfterDays", 0).ok).toBe(true);
    expect(validateConfigValue("pruneArchivedAfterDays", -1).ok).toBe(false);
    expect(validateConfigValue("pruneArchivedAfterDays", "7").ok).toBe(false);
  });

  test("failed validations include a human-readable error", () => {
    const result = validateConfigValue("port", "not-a-number");
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

describe("setNestedValue / getNestedValue", () => {
  test("sets a flat key without touching siblings", () => {
    const result = setNestedValue({ foo: "bar", port: 1 }, "port", 2);
    expect(result).toEqual({ foo: "bar", port: 2 });
  });

  test("sets a nested key, preserving sibling nested keys", () => {
    const result = setNestedValue({ ports: { mode: "auto", ignore: [] } }, "ports.maxPort", 8000);
    expect(result).toEqual({ ports: { mode: "auto", ignore: [], maxPort: 8000 } });
  });

  test("creates the parent object when it doesn't exist yet", () => {
    const result = setNestedValue({}, "ports.mode", "off");
    expect(result).toEqual({ ports: { mode: "off" } });
  });

  test("does not mutate the original object", () => {
    const original = { ports: { mode: "auto" } };
    setNestedValue(original, "ports.mode", "off");
    expect(original).toEqual({ ports: { mode: "auto" } });
  });

  test("preserves unrelated top-level keys entirely (generic JSON merge)", () => {
    const result = setNestedValue({ somethingElse: 42, port: 1 }, "port", 2);
    expect(result.somethingElse).toBe(42);
  });

  test("getNestedValue reads flat and nested paths", () => {
    expect(getNestedValue({ port: 8377 }, "port")).toBe(8377);
    expect(getNestedValue({ ports: { mode: "auto" } }, "ports.mode")).toBe("auto");
  });

  test("getNestedValue returns undefined for a missing path", () => {
    expect(getNestedValue({}, "ports.mode")).toBeUndefined();
    expect(getNestedValue({ ports: {} }, "ports.mode")).toBeUndefined();
  });
});

describe("describeEffectiveConfig", () => {
  const effective = {
    port: 8377,
    closeBehavior: "archive",
    collapseOthers: true,
    debounceMs: 200,
    reverseSync: false,
    ports: { mode: "auto", ignore: [], maxPort: 49151 },
  };

  test("every key is marked default when there is no file", () => {
    const lines = describeEffectiveConfig(effective, null);
    expect(lines.length).toBe(CONFIG_ALLOWED_KEYS.length);
    expect(lines.every((l) => l.source === "default")).toBe(true);
  });

  test("a key explicitly present in the file is marked file, others stay default", () => {
    const lines = describeEffectiveConfig(effective, { reverseSync: true });
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l.source]));
    expect(byKey.reverseSync).toBe("file");
    expect(byKey.port).toBe("default");
  });

  test("only the specific leaf that's present in the file counts as file-sourced", () => {
    // the file sets ports.maxPort but not ports.mode -- only maxPort is "file"
    const lines = describeEffectiveConfig(effective, { ports: { maxPort: 8000 } });
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l.source]));
    expect(byKey["ports.maxPort"]).toBe("file");
    expect(byKey["ports.mode"]).toBe("default");
  });

  test("values reported match the effective (merged) config, not the raw file", () => {
    const lines = describeEffectiveConfig(effective, { reverseSync: true });
    const reverseSyncLine = lines.find((l) => l.key === "reverseSync")!;
    expect(reverseSyncLine.value).toBe(false); // effective object above says false
  });
});
