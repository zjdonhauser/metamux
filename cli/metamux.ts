#!/usr/bin/env bun
// metamux CLI: open/status/state/secret/doctor/focus/prune/mcp. Reads port from
// config, token from the secret file (or METAMUX_PORT/METAMUX_TOKEN env
// overrides -- used for tests and for pointing at a non-default daemon).
// Friendly errors when the daemon isn't running.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_ALLOWED_KEYS,
  describeEffectiveConfig,
  isAllowedConfigKey,
  parseConfigValue,
  setNestedValue,
  validateConfigValue,
} from "../daemon/src/config-cli.ts";
import { loadConfig } from "../daemon/src/config.ts";
import { createHttpToolHandlers, runStdioServer } from "../daemon/src/mcp-server.ts";
import { atomicWriteJson, CONFIG_PATH, ensureSecret, secretPath } from "../daemon/src/paths.ts";
import { parseOpenArgs } from "./open-args.ts";
import { notInTmuxMessage, probeTmuxIdentity, type CallerIdentity } from "../daemon/src/model/caller-identity.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_MAIN = join(HERE, "..", "daemon", "src", "main.ts");

async function loadToken(): Promise<string | null> {
  if (process.env.METAMUX_TOKEN) return process.env.METAMUX_TOKEN;
  try {
    const text = await Bun.file(secretPath()).text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolvePort(): Promise<number> {
  if (process.env.METAMUX_PORT) return Number(process.env.METAMUX_PORT);
  return (await loadConfig()).port;
}

function notRunningError(port: number): never {
  console.error(`metamux: could not reach the daemon on 127.0.0.1:${port}.`);
  console.error(`Start it with: bun ${DAEMON_MAIN}`);
  process.exit(1);
}

async function requireToken(): Promise<string> {
  const token = await loadToken();
  if (!token) {
    console.error("metamux: no secret found. Start the daemon at least once to generate one.");
    process.exit(1);
  }
  return token;
}

async function cmdOpen(args: string[]): Promise<void> {
  const { url, active } = parseOpenArgs(args);
  if (!url) {
    console.error("usage: metamux open <url> [--active]");
    process.exit(1);
  }
  const port = await resolvePort();
  const token = await requireToken();

  // Identity comes from the tmux session this process is really in, asked for
  // at call time. $CMUX_WORKSPACE_ID was a copy taken when the pane was created
  // and went stale the moment a session was re-attached from another window.
  let identity: CallerIdentity = { kind: "not-in-tmux" };
  if (!active) {
    identity = probeTmuxIdentity();
    if (identity.kind === "not-in-tmux") {
      // Fail loud: no workspace to put this in, so hand the human the URL
      // rather than dropping it into whichever group is on screen.
      console.error(notInTmuxMessage(url));
      process.exit(1);
    }
  }

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        url,
        active,
        tmuxSessionName: identity.kind === "tmux" ? identity.sessionName : undefined,
        metamuxId: identity.kind === "tmux" ? identity.metamuxId : undefined,
      }),
    });
  } catch {
    notRunningError(port);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`metamux open failed: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`opened in workspace ${body.workspace}`);
}

async function cmdStatus(): Promise<void> {
  const port = await resolvePort();
  const token = await requireToken();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/status?token=${encodeURIComponent(token)}`);
  } catch {
    notRunningError(port);
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function cmdState(): Promise<void> {
  const port = await resolvePort();
  const token = await requireToken();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/state?token=${encodeURIComponent(token)}`);
  } catch {
    notRunningError(port);
  }
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function cmdCurrent(): Promise<void> {
  // Prefer the tmux session this process is in; fall back to the env var for a
  // cmux-native shell, where cmux sets it directly and it cannot be stale.
  const tmuxIdentity = probeTmuxIdentity();
  if (tmuxIdentity.kind === "tmux") {
    console.log(`${tmuxIdentity.sessionName}${tmuxIdentity.metamuxId ? ` (${tmuxIdentity.metamuxId})` : ""}`);
    return;
  }
  const cmuxWorkspaceId = process.env.CMUX_WORKSPACE_ID;
  if (!cmuxWorkspaceId) {
    console.error("metamux current: no $CMUX_WORKSPACE_ID (run from a cmux shell)");
    process.exit(1);
  }
  const port = await resolvePort();
  const token = await requireToken();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/state?token=${encodeURIComponent(token)}`);
  } catch {
    notRunningError(port);
  }
  const state = await res.json();
  const workspaces: Array<Record<string, unknown>> = state.workspaces ?? [];
  const mine = workspaces.find((ws) => ws.sourceId === cmuxWorkspaceId);
  if (!mine) {
    console.error(`metamux current: workspace ${cmuxWorkspaceId} not in the registry yet`);
    process.exit(1);
  }
  console.log(JSON.stringify(mine, null, 2));
}

async function cmdSecret(): Promise<void> {
  const secret = await ensureSecret();
  console.log(secret);
}

async function cmdFocus(): Promise<void> {
  const port = await resolvePort();
  const token = await requireToken();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/focus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    notRunningError(port);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`metamux focus failed: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log("focused the metamux window");
}

async function cmdPrune(): Promise<void> {
  const port = await resolvePort();
  const token = await requireToken();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/prune`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    notRunningError(port);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`metamux prune failed: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  const removed: Array<{ id: string; title: string }> = body.removed ?? [];
  if (removed.length === 0) {
    console.log("nothing to prune (no archived workspaces)");
    return;
  }
  console.log(`pruned ${removed.length} archived workspace(s):`);
  for (const r of removed) console.log(`  ${r.title} (${r.id})`);
}

async function cmdDoctor(): Promise<void> {
  const child = spawn("bun", [DAEMON_MAIN, "doctor"], { stdio: "inherit" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function readRawConfigFile(): Promise<Record<string, unknown> | null> {
  try {
    const text = await Bun.file(CONFIG_PATH).text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function cmdConfigShow(json: boolean): Promise<void> {
  const effective = await loadConfig();
  const rawFile = await readRawConfigFile();
  const lines = describeEffectiveConfig(effective as unknown as Record<string, unknown>, rawFile);
  if (json) {
    console.log(JSON.stringify(lines));
    return;
  }
  for (const line of lines) {
    console.log(`${line.key}: ${JSON.stringify(line.value)} (${line.source})`);
  }
  console.log("");
  console.log(`config file: ${CONFIG_PATH}${rawFile ? "" : " (not present -- showing defaults)"}`);
}

async function cmdConfigSet(key: string, rawValue: string): Promise<void> {
  if (!isAllowedConfigKey(key)) {
    console.error(`metamux config: unknown key "${key}"`);
    console.error(`allowed keys: ${CONFIG_ALLOWED_KEYS.join(", ")}`);
    process.exit(1);
  }

  const value = parseConfigValue(rawValue);
  const validation = validateConfigValue(key, value);
  if (!validation.ok) {
    console.error(`metamux config: ${validation.error}`);
    process.exit(1);
  }

  const rawFile = (await readRawConfigFile()) ?? {};
  const updated = setNestedValue(rawFile, key, value);
  await atomicWriteJson(CONFIG_PATH, updated);

  console.log(`set ${key} = ${JSON.stringify(value)} in ${CONFIG_PATH}`);
  console.log("Applied live if the daemon is running (hot-reload); 'port'/'eventsPath' need a restart.");
}

async function cmdConfig(args: string[]): Promise<void> {
  const jsonFlagIndex = args.indexOf("--json");
  const json = jsonFlagIndex !== -1;
  const rest = json ? [...args.slice(0, jsonFlagIndex), ...args.slice(jsonFlagIndex + 1)] : args;

  const [key, value] = rest;
  if (!key) {
    await cmdConfigShow(json);
    return;
  }
  if (json) {
    console.error(`usage: metamux config --json  (no key/value -- --json only describes the full effective config)`);
    process.exit(1);
  }
  if (value === undefined) {
    console.error(`usage: metamux config [<key> <value>]`);
    console.error(`allowed keys: ${CONFIG_ALLOWED_KEYS.join(", ")}`);
    process.exit(1);
  }
  await cmdConfigSet(key, value);
}

async function cmdMcp(): Promise<void> {
  const port = await resolvePort();
  const token = await requireToken();
  const handlers = createHttpToolHandlers({ port, token });
  await runStdioServer(handlers);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "open":
      await cmdOpen(rest);
      break;
    case "status":
      await cmdStatus();
      break;
    case "state":
      await cmdState();
      break;
    case "current":
      await cmdCurrent();
      break;
    case "secret":
      await cmdSecret();
      break;
    case "focus":
      await cmdFocus();
      break;
    case "prune":
      await cmdPrune();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "mcp":
      await cmdMcp();
      break;
    case "config":
      await cmdConfig(rest);
      break;
    default:
      console.error("usage: metamux <open <url> [--active]|current|status|state|secret|focus|prune|doctor|mcp|config [--json | <key> <value>]>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
