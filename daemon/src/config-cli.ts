// Pure logic for `metamux config`: value parsing, key validation, an
// immutable nested get/set over plain JSON objects, and diffing a raw
// config file against the effective (default-merged) config to report
// each key's source. No I/O -- the CLI does the file read/write.

export const CONFIG_ALLOWED_KEYS = [
  "port",
  "closeBehavior",
  "collapseOthers",
  "debounceMs",
  "reverseSync",
  "groupBy",
  "createGroups",
  "ports.mode",
  "ports.ignore",
  "ports.maxPort",
  "tmux.enabled",
  "tmux.mirror",
  "tmux.alphabetize",
  "tmux.reattachGraceMs",
  "tmux.spawnCwd",
  "janitor",
  "janitorCrossWindow",
  "colorBackflow",
  "pruneArchivedAfterDays",
  "colorMode",
] as const;

export type ConfigKey = (typeof CONFIG_ALLOWED_KEYS)[number];

export function isAllowedConfigKey(key: string): key is ConfigKey {
  return (CONFIG_ALLOWED_KEYS as readonly string[]).includes(key);
}

/** JSON when parseable (`true`, `false`, `8377`, `[22,5432]`, `"quoted"`),
 * else the raw string (`off`, `archive`, `auto`, ...). */
export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export interface ConfigValueValidation {
  ok: boolean;
  error?: string;
}

export function validateConfigValue(key: ConfigKey, value: unknown): ConfigValueValidation {
  switch (key) {
    case "port":
    case "debounceMs":
    case "ports.maxPort":
      return typeof value === "number" ? { ok: true } : { ok: false, error: `${key} must be a number` };
    case "reverseSync":
    case "collapseOthers":
    case "janitor":
    case "janitorCrossWindow":
    case "colorBackflow":
      return typeof value === "boolean" ? { ok: true } : { ok: false, error: `${key} must be a boolean (true/false)` };
    case "closeBehavior":
      return value === "archive" || value === "close"
        ? { ok: true }
        : { ok: false, error: `${key} must be "archive" or "close"` };
    case "ports.mode":
      return value === "auto" || value === "notify" || value === "off"
        ? { ok: true }
        : { ok: false, error: `${key} must be "auto", "notify", or "off"` };
    case "ports.ignore":
      return Array.isArray(value) && value.every((v) => typeof v === "number")
        ? { ok: true }
        : { ok: false, error: `${key} must be an array of port numbers, e.g. [22,5432]` };
    case "groupBy":
      return value === "title" || value === "workspace"
        ? { ok: true }
        : { ok: false, error: `${key} must be "title" or "workspace"` };
    case "createGroups":
      // Strict to the current 3 values -- "lazy" is tolerated only when
      // READING an existing config file (config.ts's loadConfig), not for
      // a fresh write here; guide callers to the current vocabulary.
      return value === "on-open" || value === "on-activate" || value === "eager"
        ? { ok: true }
        : { ok: false, error: `${key} must be "on-open", "on-activate", or "eager"` };
    case "tmux.enabled":
    case "tmux.alphabetize":
      return typeof value === "boolean" ? { ok: true } : { ok: false, error: `${key} must be a boolean (true/false)` };
    case "tmux.mirror":
      return value === "windows" || value === "global"
        ? { ok: true }
        : { ok: false, error: `${key} must be "windows" or "global"` };
    case "tmux.reattachGraceMs":
      return typeof value === "number" ? { ok: true } : { ok: false, error: `${key} must be a number` };
    case "pruneArchivedAfterDays":
      return typeof value === "number" && value >= 0
        ? { ok: true }
        : { ok: false, error: `${key} must be a number >= 0 (0 disables auto-compaction)` };
    case "tmux.spawnCwd":
      return typeof value === "string" && value.length > 0
        ? { ok: true }
        : { ok: false, error: `${key} must be a non-empty string` };
    case "colorMode":
      return value === "palette" || value === "hash"
        ? { ok: true }
        : { ok: false, error: `${key} must be "palette" or "hash"` };
  }
}

/** Immutable nested-set: returns a NEW object with `dottedKey` set to
 * `value`, preserving every other key at every level (a generic JSON
 * merge, not config-shape-aware -- this is what lets an unrelated
 * hand-edited key in config.json survive a `metamux config` write). */
export function setNestedValue(
  obj: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = dottedKey.split(".");
  if (!head) return obj;
  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }
  const existingChild =
    obj[head] && typeof obj[head] === "object" && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: setNestedValue(existingChild, rest.join("."), value) };
}

/** Reads a dotted key path out of a plain object. undefined if any segment
 * along the path is missing or the path runs into a non-object. */
export function getNestedValue(obj: Record<string, unknown>, dottedKey: string): unknown {
  let cur: unknown = obj;
  for (const part of dottedKey.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface ConfigLine {
  key: ConfigKey;
  value: unknown;
  source: "file" | "default";
}

/** Describes the effective value of every allowed key, and whether that
 * value came from the raw file JSON or is an unset default. `effective`
 * is the fully-merged config (as loadConfig returns); `rawFile` is the
 * as-parsed config.json (or null if missing/invalid). */
export function describeEffectiveConfig(
  effective: Record<string, unknown>,
  rawFile: Record<string, unknown> | null,
): ConfigLine[] {
  return CONFIG_ALLOWED_KEYS.map((key) => ({
    key,
    value: getNestedValue(effective, key),
    source: rawFile !== null && getNestedValue(rawFile, key) !== undefined ? "file" : "default",
  }));
}
