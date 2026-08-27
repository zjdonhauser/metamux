#!/usr/bin/env bun
// The real implementation behind layout/metamux.sh (a SwiftBar streamable
// plugin -- see that file's header for why the logic lives here instead).
//
// Renders the full metamux menu on: the daemon's initial `sync` frame,
// every workspace.activated/upserted/archived event, and a 60s heartbeat.
// The heartbeat exists because config-only hot-reloads (e.g. reverseSync)
// don't push a WS event -- only collapseOthers/closeBehavior changes do,
// see applyConfigChanges in daemon/src/main.ts -- so it's the safety net
// for every other toggle in the Experimental features submenu.
//
// Never exits: SwiftBar restarts a streamable plugin that exits, and a
// tight crash loop is worse than a stale menu, so every failure path logs
// to stderr (never stdout -- that would corrupt the menu) and retries.

import { describeEffectiveConfig, type ConfigLine } from "../daemon/src/config-cli.ts";
import { loadConfig } from "../daemon/src/config.ts";
import { CONFIG_PATH, secretPath } from "../daemon/src/paths.ts";

const REPO = "/Users/zachary/Documents/GitHub/metamux";
const BUN = "/Users/zachary/.bun/bin/bun";
const CLI = `${REPO}/cli/metamux.ts`;
const HEARTBEAT_MS = 60_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const HTTP_TIMEOUT_MS = 1_000;

const ENUM_CYCLES: Record<string, readonly string[]> = {
  closeBehavior: ["archive", "close"],
  "ports.mode": ["auto", "notify", "off"],
};

function enumNext(key: string, current: unknown): string | null {
  const cycle = ENUM_CYCLES[key];
  if (!cycle) return null;
  const idx = cycle.indexOf(String(current));
  if (idx === -1) return null;
  return cycle[(idx + 1) % cycle.length] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let renderedOnce = false;

/** Emits one full menu render, prefixed with the streamable `~~~` reset
 * separator for every render after the first. */
function emit(lines: string[]): void {
  if (renderedOnce) console.log("~~~");
  renderedOnce = true;
  console.log(lines.join("\n"));
}

function failMenu(reason: string): string[] {
  return ["metamux ✕", "---", reason, `Open README | bash=/usr/bin/open param1=${REPO}/README.md terminal=false`];
}

/** GENERATED from describeEffectiveConfig(), so a new config key shows up
 * here the moment it's added to CONFIG_ALLOWED_KEYS in
 * daemon/src/config-cli.ts, with no edit to this plugin. Rendering is
 * driven by the value's own type:
 *   boolean -> a checkbox that toggles the other value on click
 *   string  -> an enum: current value, cycles to the next one on click IF
 *              this file knows that key's cycle (see ENUM_CYCLES above);
 *              otherwise shown read-only, so an unknown future enum
 *              degrades gracefully instead of guessing its legal values
 *   number / array -> shown read-only (nothing to toggle) */
function renderExperimentalFeatures(lines: ConfigLine[]): string[] {
  const out = ["Experimental features"];
  for (const { key, value } of lines) {
    if (typeof value === "boolean") {
      const mark = value ? "✓" : "  ";
      out.push(
        `--${mark} ${key} | bash=${BUN} param1=${CLI} param2=config param3=${key} param4=${!value} terminal=false refresh=true`,
      );
    } else if (typeof value === "number") {
      out.push(`--${key}: ${value}`);
    } else if (Array.isArray(value)) {
      out.push(`--${key}: ${JSON.stringify(value)}`);
    } else {
      const next = enumNext(key, value);
      out.push(
        next
          ? `--${key}: ${value} (click to cycle -> ${next}) | bash=${BUN} param1=${CLI} param2=config param3=${key} param4=${next} terminal=false refresh=true`
          : `--${key}: ${value}`,
      );
    }
  }
  out.push("--—");
  out.push("--changes apply live if the daemon supports hot-reload, else restart it");
  return out;
}

interface DaemonView {
  port: number;
  token: string;
}

interface StatusResponse {
  clients: number;
  lastSeq: number;
  workspaces: number;
}

async function fetchStatus(view: DaemonView): Promise<StatusResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/status?token=${encodeURIComponent(view.token)}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as StatusResponse;
  } catch {
    return null;
  }
}

async function readRawConfigFile(): Promise<Record<string, unknown> | null> {
  try {
    const text = await Bun.file(CONFIG_PATH).text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadToken(): Promise<string | null> {
  try {
    const text = await Bun.file(secretPath()).text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function buildMenu(view: DaemonView, activeTitle: string | null): Promise<string[]> {
  const [config, rawFile, status] = await Promise.all([loadConfig(), readRawConfigFile(), fetchStatus(view)]);
  const configLines = describeEffectiveConfig(config as unknown as Record<string, unknown>, rawFile);

  const menu: string[] = [];
  menu.push(activeTitle ? `🧭 ${activeTitle}` : "🧭 metamux");
  menu.push("---");
  menu.push(`Focus browser window | bash=${BUN} param1=${CLI} param2=focus terminal=false refresh=true`);
  menu.push(
    `Open clipboard URL in current workspace | bash=${REPO}/layout/metamux-open-clipboard.sh terminal=false refresh=false`,
  );
  menu.push(...renderExperimentalFeatures(configLines));
  menu.push("---");
  menu.push(status ? `clients: ${status.clients}  lastSeq: ${status.lastSeq}  workspaces: ${status.workspaces}` : "status unavailable");
  menu.push("---");
  menu.push(`Open README | bash=/usr/bin/open param1=${REPO}/README.md terminal=false`);
  return menu;
}

/** Pulls the active workspace's title out of a `sync` frame's `state`. */
function activeTitleFromState(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const s = state as Record<string, unknown>;
  const activeId = typeof s.activeId === "string" ? s.activeId : null;
  const workspaces = Array.isArray(s.workspaces) ? s.workspaces : [];
  if (!activeId) return null;
  for (const w of workspaces) {
    if (w && typeof w === "object" && (w as Record<string, unknown>).id === activeId) {
      const title = (w as Record<string, unknown>).title;
      return typeof title === "string" ? title : null;
    }
  }
  return null;
}

const RERENDER_EVENT_NAMES = new Set(["workspace.activated", "workspace.upserted", "workspace.archived"]);

interface ConnectionResult {
  everSynced: boolean;
}

/** Runs one WebSocket connection lifecycle to completion (resolves once
 * the socket closes or fails to open). Never rejects -- every failure
 * mode is caught and folded into a normal resolution so the caller's
 * reconnect loop doesn't need its own try/catch around this call. */
function runConnection(view: DaemonView): Promise<ConnectionResult> {
  return new Promise((resolve) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let activeTitle: string | null = null;
    let everSynced = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      resolve({ everSynced });
    };

    const rerender = () => {
      buildMenu(view, activeTitle)
        .then(emit)
        .catch((err) => console.error(`[metamux menubar] render failed: ${String(err)}`));
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${view.port}/actuator`);
    } catch (err) {
      console.error(`[metamux menubar] failed to open socket: ${String(err)}`);
      finish();
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", token: view.token, protocol: 1, client: "menubar" }));
    };

    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const obj = msg as Record<string, unknown>;

      if (obj.type === "sync") {
        activeTitle = activeTitleFromState(obj.state);
        everSynced = true;
        rerender();
        if (!heartbeat) heartbeat = setInterval(rerender, HEARTBEAT_MS);
        return;
      }

      if (obj.type === "event" && typeof obj.name === "string" && RERENDER_EVENT_NAMES.has(obj.name)) {
        if (obj.name === "workspace.activated" && obj.workspace && typeof obj.workspace === "object") {
          const title = (obj.workspace as Record<string, unknown>).title;
          if (typeof title === "string") activeTitle = title;
        }
        rerender();
      }
    };

    ws.onerror = () => {
      // onclose always follows -- let it drive teardown so we only settle once.
    };

    ws.onclose = () => finish();
  });
}

async function main(): Promise<void> {
  emit(["🧭 metamux (connecting…)"]);

  let backoff = RECONNECT_MIN_MS;
  while (true) {
    try {
      const token = await loadToken();
      if (!token) {
        emit(failMenu(`no secret yet — start the daemon once: bun ${REPO}/daemon/src/main.ts`));
      } else {
        const config = await loadConfig();
        const view: DaemonView = { port: config.port, token };
        const { everSynced } = await runConnection(view);
        emit(failMenu(`daemon not reachable on 127.0.0.1:${view.port}`));
        if (everSynced) backoff = RECONNECT_MIN_MS;
      }
    } catch (err) {
      console.error(`[metamux menubar] loop error: ${String(err)}`);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

process.on("uncaughtException", (err) => console.error(`[metamux menubar] uncaught: ${String(err)}`));
process.on("unhandledRejection", (err) => console.error(`[metamux menubar] unhandled rejection: ${String(err)}`));

main();
