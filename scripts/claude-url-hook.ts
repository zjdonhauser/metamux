#!/usr/bin/env bun
// Claude Code PostToolUse hook. Wire it up as:
//   matcher: "Bash"
//   command: "bun /Users/zachary/Documents/GitHub/metamux/scripts/claude-url-hook.ts"
//
// Reads the hook JSON payload from stdin. When a Bash tool call's output
// contains a high-signal GitHub URL (a PR view/create link or a branch
// compare link), POSTs it to the metamux daemon's /open so it lands in the
// user's paired Chrome tab group for the active cmux workspace.
//
// Must never block or break the session: every failure mode (daemon down,
// no CMUX_WORKSPACE_ID, no match, bad JSON) exits 0 fast and silently. A
// hard watchdog forces exit within ~1s even if a network call hangs.

import { extractGithubUrls, dedupeAgainstRecent, type RecentUrls } from "./url-extract.ts";
import { loadConfig } from "../daemon/src/config.ts";
import { atomicWriteJson, ensureStateDir, secretPath, STATE_DIR } from "../daemon/src/paths.ts";
import { join } from "node:path";

const HARD_TIMEOUT_MS = 1000;
const FETCH_TIMEOUT_MS = 600;

function recentUrlsPath(): string {
  return join(STATE_DIR, "hook-recent.json");
}

async function loadRecentUrls(): Promise<RecentUrls> {
  try {
    const text = await Bun.file(recentUrlsPath()).text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as RecentUrls) : {};
  } catch {
    return {};
  }
}

async function saveRecentUrls(recent: RecentUrls): Promise<void> {
  try {
    await ensureStateDir();
    await atomicWriteJson(recentUrlsPath(), recent);
  } catch {
    // best effort -- a failed write just means we might re-open a URL later
  }
}

async function postOpen(port: number, token: string, url: string, cmuxWorkspaceId: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, url, cmuxWorkspaceId }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // daemon down / unreachable / timed out -- silent, this hook never blocks the session
  }
}

async function main(): Promise<void> {
  const cmuxWorkspaceId = process.env.CMUX_WORKSPACE_ID;
  if (!cmuxWorkspaceId) return; // not a cmux-spawned shell -- nothing to target

  let raw: string;
  try {
    raw = await Bun.stdin.text();
  } catch {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (obj.tool_name !== "Bash") return;

  // Shape-tolerant: scan the whole payload (tool_input + tool_response,
  // whatever fields this Claude Code version sends) rather than betting on
  // one exact field name for command output.
  const candidates = extractGithubUrls(JSON.stringify(obj));
  if (candidates.length === 0) return;

  const now = Date.now();
  const recent = await loadRecentUrls();
  const { fresh, updated } = dedupeAgainstRecent(candidates, recent, now);
  if (fresh.length === 0) return;

  const [config, token] = await Promise.all([
    loadConfig(),
    Bun.file(secretPath())
      .text()
      .then((t) => t.trim())
      .catch(() => ""),
  ]);
  if (!token) return;

  await Promise.all(fresh.map((url) => postOpen(config.port, token, url, cmuxWorkspaceId)));
  await saveRecentUrls(updated);
}

const watchdog = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);

main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(watchdog);
    process.exit(0);
  });
