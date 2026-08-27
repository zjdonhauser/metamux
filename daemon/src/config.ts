// Loads ~/.config/metamux/config.json with the contract's defaults.
// Tolerant of a missing or invalid file -- always returns a full config.

import { readFile } from "node:fs/promises";
import { CONFIG_PATH, expandHome } from "./paths.ts";

export interface PortsConfig {
  mode: "auto" | "notify" | "off";
  ignore: number[];
  /** Ports > maxPort are never auto-opened (macOS ephemeral range). */
  maxPort: number;
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
  /** "lazy" only includes identities that are active or have been
   * attached (activated/open_url'd) at least once -- avoids materializing
   * a group for every workspace the daemon has ever seen on first
   * connect. "eager" includes everything, as before. */
  createGroups: "lazy" | "eager";
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
  createGroups: "lazy",
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

  const config: MetamuxConfig = {
    port: typeof obj.port === "number" ? obj.port : DEFAULT_CONFIG.port,
    eventsPath: typeof obj.eventsPath === "string" ? obj.eventsPath : DEFAULT_CONFIG.eventsPath,
    closeBehavior: obj.closeBehavior === "close" ? "close" : "archive",
    collapseOthers: typeof obj.collapseOthers === "boolean" ? obj.collapseOthers : DEFAULT_CONFIG.collapseOthers,
    debounceMs: typeof obj.debounceMs === "number" ? obj.debounceMs : DEFAULT_CONFIG.debounceMs,
    ports: { mode, ignore, maxPort },
    reverseSync: typeof obj.reverseSync === "boolean" ? obj.reverseSync : DEFAULT_CONFIG.reverseSync,
    groupBy: obj.groupBy === "workspace" ? "workspace" : "title",
    createGroups: obj.createGroups === "eager" ? "eager" : "lazy",
  };

  config.eventsPath = expandHome(config.eventsPath);
  return config;
}
