// Loads ~/.config/metamux/config.json with the contract's defaults.
// Tolerant of a missing or invalid file -- always returns a full config.

import { readFile } from "node:fs/promises";
import { CONFIG_PATH, expandHome } from "./paths.ts";
import { resolveMirrorMode, type MirrorMode } from "./tmux-source.ts";

export interface PortsConfig {
  mode: "auto" | "notify" | "off";
  ignore: number[];
  /** Ports > maxPort are never auto-opened (macOS ephemeral range). */
  maxPort: number;
}

export interface TmuxConfig {
  /** Master switch for the tmux source adapter + cmux actuator
   * (docs/tmux-port-plan.md §2). Off by default -- absorbing
   * tmux-cmux-sync is an opt-in cutover, not automatic on upgrade. */
  enabled: boolean;
  /** "partition" (default): each tmux session lives in exactly one cmux
   * tab, in exactly one cmux window (docs/protocol.md, "Window pairing").
   * "windows": every cmux window mirrors every tmux session (true
   * mirroring, one client per window -- plan §1.2, legacy). "global": one
   * tab per session across all windows, unattended sessions only
   * (legacy). */
  mirror: MirrorMode;
  /** Pinned tabs stay put; unpinned tabs sort case-insensitively by
   * title (plan §1.6). */
  alphabetize: boolean;
  /** Throttle (ms) before a reattach is retried for the same tab/session
   * -- unifies the original tool's two separately-named grace periods
   * (TMUX_CMUX_GRACE, TMUX_CMUX_REATTACH_GRACE; plan §4). */
  reattachGraceMs: number;
  /** --cwd for a spawned tab's `tmux new -A -s` command -- a fixed
   * directory, not "the session's real cwd" (plan §1.10/§2.1). */
  spawnCwd: string;
}

export interface MetamuxConfig {
  port: number;
  eventsPath: string;
  closeBehavior: "archive" | "close";
  collapseOthers: boolean;
  debounceMs: number;
  ports: PortsConfig;
  reverseSync: boolean;
  /** "title" aliases all same-title workspaces to one actuator identity
   * (tmux-cmux-sync mirrors every session into every window, so the
   * registry legitimately holds several same-titled workspaces).
   * "workspace" preserves one identity per real workspace. */
  groupBy: "title" | "workspace";
  /** "on-open" (default): a group is only ever created carrying a real
   * tab -- attachment happens ONLY via open_url, never activation/window
   * follow. "on-activate": the old "lazy" semantics -- activation also
   * attaches, so switching to a workspace shows its (possibly empty)
   * group. "eager": includes everything regardless of attachment, as
   * before. A config file's legacy "lazy" value reads as "on-activate". */
  createGroups: "on-open" | "on-activate" | "eager";
  tmux: TmuxConfig;
  /** Extension-side tab-group janitor: merges duplicate-titled groups and
   * closes blank orphans left over from the pre-dedupe/eager eras, on every
   * sync reconciliation. Default true. */
  janitor: boolean;
  /** Window-split recovery (2026-08-27): extends the janitor scan to
   * managed-title groups found in windows OTHER than the metamux window --
   * their tabs get moved into the canonical in-window group instead of
   * being left stranded (docs/protocol.md, "Window-split recovery").
   * Foreign (unmanaged-title) groups in other windows are never touched
   * regardless of this setting. Default true. */
  janitorCrossWindow: boolean;
  /** Color backflow (daemon/src/color-backflow.ts): paints a cmux tab's
   * own color to match its Chrome group's color when that color is the
   * title-hash fallback (never overwrites a user-set cmux color). Default
   * true. */
  colorBackflow: boolean;
  /** Registry compaction (auto, on startup): archived refs with
   * updatedAt older than this many days are dropped -- see
   * Registry.pruneArchived. 0 disables auto-compaction entirely. Only
   * takes effect at daemon startup, not hot-reloadable. Default 7. */
  pruneArchivedAfterDays: number;
  /** "palette" (default): allocates a distinguishable entry from
   * palette.ts's ordered brand colors per identity at attachment time
   * (palette-allocator.ts) -- replaces the title-hash fallback for any
   * identity without a user-set color, so colors land visually distinct
   * instead of two identities landing on the same hash bucket. "hash":
   * disables allocation entirely, restoring the original title-hash-only
   * fallback behavior. */
  colorMode: "palette" | "hash";
}

export const DEFAULT_CONFIG: MetamuxConfig = {
  port: 8377,
  eventsPath: "~/.cmuxterm/events.jsonl",
  closeBehavior: "archive",
  collapseOthers: true,
  debounceMs: 200,
  ports: { mode: "auto", ignore: [], maxPort: 49151 },
  reverseSync: false,
  groupBy: "title",
  createGroups: "on-open",
  tmux: { enabled: false, mirror: "partition", alphabetize: true, reattachGraceMs: 8000, spawnCwd: "~/Documents/GitHub" },
  janitor: true,
  janitorCrossWindow: true,
  colorBackflow: true,
  pruneArchivedAfterDays: 7,
  colorMode: "palette",
};

export async function loadConfig(path: string = CONFIG_PATH): Promise<MetamuxConfig> {
  let raw: unknown = null;
  try {
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }

  const obj: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const portsObj = (obj.ports && typeof obj.ports === "object") ? (obj.ports as Record<string, unknown>) : {};
  const mode = portsObj.mode === "notify" || portsObj.mode === "off" ? portsObj.mode : "auto";
  const ignore = Array.isArray(portsObj.ignore) ? portsObj.ignore.filter((p): p is number => typeof p === "number") : [];
  const maxPort = typeof portsObj.maxPort === "number" ? portsObj.maxPort : DEFAULT_CONFIG.ports.maxPort;

  const tmuxObj = (obj.tmux && typeof obj.tmux === "object") ? (obj.tmux as Record<string, unknown>) : {};
  // TMUX_CMUX_MIRROR env compatibility: only consulted when config.json
  // doesn't explicitly set tmux.mirror -- an explicit file value always
  // wins over the env, matching every other config key's precedence.
  const mirror =
    tmuxObj.mirror === "global" || tmuxObj.mirror === "windows" || tmuxObj.mirror === "partition"
      ? tmuxObj.mirror
      : resolveMirrorMode(DEFAULT_CONFIG.tmux.mirror);
  const tmux = {
    enabled: typeof tmuxObj.enabled === "boolean" ? tmuxObj.enabled : DEFAULT_CONFIG.tmux.enabled,
    mirror,
    alphabetize: typeof tmuxObj.alphabetize === "boolean" ? tmuxObj.alphabetize : DEFAULT_CONFIG.tmux.alphabetize,
    reattachGraceMs: typeof tmuxObj.reattachGraceMs === "number" ? tmuxObj.reattachGraceMs : DEFAULT_CONFIG.tmux.reattachGraceMs,
    spawnCwd: typeof tmuxObj.spawnCwd === "string" ? tmuxObj.spawnCwd : DEFAULT_CONFIG.tmux.spawnCwd,
  };

  // METAMUX_PORT: tolerant override, same isolation purpose as paths.ts's
  // METAMUX_STATE_DIR/METAMUX_CONFIG_PATH -- takes precedence over the
  // config file's own `port` (env is the more explicit, per-invocation
  // signal a spawned test daemon sets deliberately).
  const envPort = process.env.METAMUX_PORT ? Number(process.env.METAMUX_PORT) : null;
  const port = envPort !== null && Number.isFinite(envPort) ? envPort : typeof obj.port === "number" ? obj.port : DEFAULT_CONFIG.port;

  const config: MetamuxConfig = {
    port,
    eventsPath: typeof obj.eventsPath === "string" ? obj.eventsPath : DEFAULT_CONFIG.eventsPath,
    closeBehavior: obj.closeBehavior === "close" ? "close" : "archive",
    collapseOthers: typeof obj.collapseOthers === "boolean" ? obj.collapseOthers : DEFAULT_CONFIG.collapseOthers,
    debounceMs: typeof obj.debounceMs === "number" ? obj.debounceMs : DEFAULT_CONFIG.debounceMs,
    ports: { mode, ignore, maxPort },
    reverseSync: typeof obj.reverseSync === "boolean" ? obj.reverseSync : DEFAULT_CONFIG.reverseSync,
    groupBy: obj.groupBy === "workspace" ? "workspace" : "title",
    // Back-compat: a config file written before this rename still says
    // "lazy" -- read it as "on-activate", its exact behavioral successor.
    createGroups:
      obj.createGroups === "eager"
        ? "eager"
        : obj.createGroups === "on-activate" || obj.createGroups === "lazy"
          ? "on-activate"
          : DEFAULT_CONFIG.createGroups,
    tmux,
    janitor: typeof obj.janitor === "boolean" ? obj.janitor : DEFAULT_CONFIG.janitor,
    janitorCrossWindow: typeof obj.janitorCrossWindow === "boolean" ? obj.janitorCrossWindow : DEFAULT_CONFIG.janitorCrossWindow,
    colorBackflow: typeof obj.colorBackflow === "boolean" ? obj.colorBackflow : DEFAULT_CONFIG.colorBackflow,
    pruneArchivedAfterDays:
      typeof obj.pruneArchivedAfterDays === "number" ? obj.pruneArchivedAfterDays : DEFAULT_CONFIG.pruneArchivedAfterDays,
    colorMode: obj.colorMode === "hash" ? "hash" : DEFAULT_CONFIG.colorMode,
  };

  config.eventsPath = expandHome(config.eventsPath);
  config.tmux.spawnCwd = expandHome(config.tmux.spawnCwd);
  return config;
}
