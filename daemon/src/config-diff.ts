// Pure config diff/classification for hot-reload. No I/O -- the watcher
// (config-watch.ts) reads the file and calls this; main.ts decides what to
// do with each ConfigChange (apply live, or log "restart required for").

import type { MetamuxConfig } from "./config.ts";

export type ConfigChangeKey =
  | "port"
  | "eventsPath"
  | "closeBehavior"
  | "collapseOthers"
  | "debounceMs"
  | "reverseSync"
  | "groupBy"
  | "createGroups"
  | "ports.mode"
  | "ports.ignore"
  | "ports.maxPort"
  | "tmux.enabled"
  | "tmux.mirror"
  | "tmux.alphabetize"
  | "tmux.reattachGraceMs"
  | "tmux.spawnCwd"
  | "janitor"
  | "janitorCrossWindow"
  | "colorBackflow"
  | "pruneArchivedAfterDays"
  | "colorMode";

export interface ConfigChange {
  key: ConfigChangeKey;
  oldValue: unknown;
  newValue: unknown;
  hotApplicable: boolean;
}

/** Applied live without a daemon restart. port and eventsPath need a
 * restart (rebind / fresh tail from a new file); pruneArchivedAfterDays
 * needs one too -- auto-compaction only ever runs once, at startup, so
 * there's no live behavior a hot-apply could trigger. */
export const HOT_APPLICABLE_CONFIG_KEYS: ReadonlySet<ConfigChangeKey> = new Set([
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
  "janitorCrossWindow",
  "colorBackflow",
  "colorMode",
]);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

/** Diffs two loaded configs key by key (including nested ports.*), reporting
 * only the keys that actually changed, each tagged with whether it can be
 * applied live. */
export function diffConfig(oldConfig: MetamuxConfig, newConfig: MetamuxConfig): ConfigChange[] {
  const candidates: { key: ConfigChangeKey; oldValue: unknown; newValue: unknown }[] = [
    { key: "port", oldValue: oldConfig.port, newValue: newConfig.port },
    { key: "eventsPath", oldValue: oldConfig.eventsPath, newValue: newConfig.eventsPath },
    { key: "closeBehavior", oldValue: oldConfig.closeBehavior, newValue: newConfig.closeBehavior },
    { key: "collapseOthers", oldValue: oldConfig.collapseOthers, newValue: newConfig.collapseOthers },
    { key: "debounceMs", oldValue: oldConfig.debounceMs, newValue: newConfig.debounceMs },
    { key: "reverseSync", oldValue: oldConfig.reverseSync, newValue: newConfig.reverseSync },
    { key: "groupBy", oldValue: oldConfig.groupBy, newValue: newConfig.groupBy },
    { key: "createGroups", oldValue: oldConfig.createGroups, newValue: newConfig.createGroups },
    { key: "ports.mode", oldValue: oldConfig.ports.mode, newValue: newConfig.ports.mode },
    { key: "ports.ignore", oldValue: oldConfig.ports.ignore, newValue: newConfig.ports.ignore },
    { key: "ports.maxPort", oldValue: oldConfig.ports.maxPort, newValue: newConfig.ports.maxPort },
    { key: "tmux.enabled", oldValue: oldConfig.tmux.enabled, newValue: newConfig.tmux.enabled },
    { key: "tmux.mirror", oldValue: oldConfig.tmux.mirror, newValue: newConfig.tmux.mirror },
    { key: "tmux.alphabetize", oldValue: oldConfig.tmux.alphabetize, newValue: newConfig.tmux.alphabetize },
    { key: "tmux.reattachGraceMs", oldValue: oldConfig.tmux.reattachGraceMs, newValue: newConfig.tmux.reattachGraceMs },
    { key: "tmux.spawnCwd", oldValue: oldConfig.tmux.spawnCwd, newValue: newConfig.tmux.spawnCwd },
    { key: "janitor", oldValue: oldConfig.janitor, newValue: newConfig.janitor },
    { key: "janitorCrossWindow", oldValue: oldConfig.janitorCrossWindow, newValue: newConfig.janitorCrossWindow },
    { key: "colorBackflow", oldValue: oldConfig.colorBackflow, newValue: newConfig.colorBackflow },
    { key: "pruneArchivedAfterDays", oldValue: oldConfig.pruneArchivedAfterDays, newValue: newConfig.pruneArchivedAfterDays },
    { key: "colorMode", oldValue: oldConfig.colorMode, newValue: newConfig.colorMode },
  ];

  return candidates
    .filter((c) => !deepEqual(c.oldValue, c.newValue))
    .map((c) => ({ ...c, hotApplicable: HOT_APPLICABLE_CONFIG_KEYS.has(c.key) }));
}
